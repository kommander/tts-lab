import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, patch

import infer


class SynthesisParameterTests(unittest.TestCase):
    def test_defaults_match_public_profiles(self):
        self.assertEqual(infer.parse_request_parameters("kitten", {}), {"speed": 1.0})
        self.assertEqual(
            infer.parse_request_parameters("qwen", {}),
            {
                "language": "auto",
                "style": "natural",
                "temperature": "official",
                "topP": 1.0,
                "topK": 50,
                "repetitionPenalty": 1.05,
                "maxTokens": 2048,
                "seed": 42,
            },
        )
        self.assertEqual(
            infer.parse_request_parameters("f5", {}),
            {"speed": 1.0, "nfeSteps": 32, "seed": 42, "crossFade": 0.15, "removeSilence": False},
        )

    def test_enum_values_remain_strings(self):
        parameters = infer.parse_synthesis_parameters("qwen", {"style": "expressive", "temperature": "stable", "seed": 7})
        self.assertEqual(parameters, {
            "language": "auto",
            "style": "expressive",
            "temperature": "stable",
            "topP": 1.0,
            "topK": 50,
            "repetitionPenalty": 1.05,
            "maxTokens": 2048,
            "seed": 7,
        })
        self.assertIsInstance(parameters["temperature"], str)

    def test_rejects_unknown_wrong_type_range_step_and_explicit_null(self):
        invalid = [
            ("kitten", {"unknown": 1}),
            ("kitten", {"speed": True}),
            ("kitten", {"speed": 2.1}),
            ("kitten", {"speed": 1.03}),
            ("qwen", {"temperature": 0.7}),
            ("qwen", {"temperature": "hot"}),
            ("qwen", {"seed": 2147483646.5}),
            ("qwen", {"maxTokens": 513}),
            ("qwen", {"topP": 0.93}),
            ("f5", {"nfeSteps": 15}),
        ]
        for model, parameters in invalid:
            with self.subTest(model=model, parameters=parameters):
                with self.assertRaises(ValueError):
                    infer.parse_synthesis_parameters(model, parameters)
        with self.assertRaisesRegex(ValueError, "must be an object"):
            infer.parse_request_parameters("melo", {"parameters": None})

    def test_builds_parler_official_description_template(self):
        parameters = infer.parse_synthesis_parameters(
            "parler",
            {"rate": "fast", "pitch": "low", "expression": "neutral"},
        )
        description = infer.build_parler_description("Jon", parameters)
        self.assertIn("Jon's voice is clear and neutral", description)
        self.assertIn("fast speaking rate and low pitch", description)
        self.assertIn("very clear audio", description)

    def test_qwen_forwards_mapped_temperature_seed_and_fixed_safety_ceiling(self):
        seeds = []
        generated = []
        text = "first unpunctuated line\nsecond unpunctuated line\nthird unpunctuated line"
        mlx = ModuleType("mlx")
        mlx.__path__ = []
        mlx_core = ModuleType("mlx.core")
        mlx_core.random = SimpleNamespace(seed=seeds.append)
        numpy = ModuleType("numpy")
        model = SimpleNamespace(
            tokenizer=SimpleNamespace(encode=lambda text: [1, 2]),
            generate_custom_voice=lambda **kwargs: generated.append(kwargs) or [],
        )
        with (
            patch.dict("sys.modules", {"mlx": mlx, "mlx.core": mlx_core, "numpy": numpy}),
            patch.object(infer, "create_qwen_model", return_value=model),
        ):
            synthesize = infer.load_qwen(Path("/assets"))
            with self.assertRaisesRegex(RuntimeError, "produced no audio"):
                synthesize(
                    text,
                    Path("out.wav"),
                    parameters={
                        "language": "english",
                        "style": "steady",
                        "temperature": "official",
                        "topP": 0.9,
                        "topK": 30,
                        "repetitionPenalty": 1.1,
                        "maxTokens": 1024,
                        "seed": 7,
                    },
                )
        self.assertEqual(seeds, [7])
        self.assertEqual(generated[0]["temperature"], 0.9)
        self.assertEqual(generated[0]["max_tokens"], 1024)
        self.assertEqual(generated[0]["language"], "english")
        self.assertEqual(generated[0]["top_p"], 0.9)
        self.assertEqual(generated[0]["top_k"], 30)
        self.assertEqual(generated[0]["repetition_penalty"], 1.1)
        self.assertIn("steady, measured pace", generated[0]["instruct"])
        self.assertEqual(generated[0]["text"], text)
        self.assertEqual(len(generated), 1)

    def test_piper_and_f5_forward_only_public_parameters(self):
        piper = ModuleType("piper")
        piper_voice = MagicMock()
        piper_voice.config.length_scale = 1.4
        piper.PiperVoice = SimpleNamespace(load=lambda path: piper_voice)
        piper.SynthesisConfig = lambda **kwargs: SimpleNamespace(**kwargs)
        wav_context = MagicMock()
        with patch.dict("sys.modules", {"piper": piper}), patch.object(infer.wave, "open", return_value=wav_context):
            synthesize_piper = infer.load_piper(Path("/assets"))
            synthesize_piper("hello", Path("out.wav"), parameters={"speed": "fast"})
        piper_config = piper_voice.synthesize_wav.call_args.kwargs["syn_config"]
        self.assertAlmostEqual(piper_config.length_scale, 0.7)

        f5_package = ModuleType("f5_tts")
        f5_package.__path__ = []
        f5_api = ModuleType("f5_tts.api")
        f5_instance = MagicMock()
        f5_api.F5TTS = lambda **kwargs: f5_instance
        with (
            patch.dict("sys.modules", {"f5_tts": f5_package, "f5_tts.api": f5_api}),
            patch("importlib.resources.files", return_value=Path("/package")),
        ):
            synthesize_f5 = infer.load_f5(Path("/assets"))
            synthesize_f5(
                "hello",
                Path("out.wav"),
                parameters={
                    "speed": 1.2,
                    "nfeSteps": 16,
                    "seed": 9,
                    "crossFade": 0.25,
                    "removeSilence": True,
                },
            )
        forwarded = f5_instance.infer.call_args.kwargs
        self.assertEqual(
            {key: forwarded[key] for key in ("speed", "nfe_step", "seed", "cross_fade_duration", "remove_silence")},
            {"speed": 1.2, "nfe_step": 16, "seed": 9, "cross_fade_duration": 0.25, "remove_silence": True},
        )


if __name__ == "__main__":
    unittest.main()
