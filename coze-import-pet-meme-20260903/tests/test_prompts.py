from pet_meme.prompts import build_generation_prompt


def test_prompt_preserves_meme_surface_and_limits_replacement_to_animal():
    prompt = build_generation_prompt(pet_count=2, adjustment="")

    assert "preserve all original visible text exactly" in prompt
    assert "composition, camera angle, pose, expression, action" in prompt
    assert "transparency, blur, compression artifacts, low-resolution web-image texture" in prompt
    assert "Replace only the single animal subject" in prompt
    assert "pet reference photos must never change the output aspect ratio" in prompt
    assert "2 pet reference photos" in prompt


def test_prompt_includes_user_adjustment_for_regeneration():
    prompt = build_generation_prompt(pet_count=1, adjustment="让表情更欠揍一点")

    assert "User adjustment for this regeneration" in prompt
    assert "让表情更欠揍一点" in prompt


def test_prompt_requests_platform_watermark_removal_when_confirmed():
    prompt = build_generation_prompt(pet_count=1, adjustment="", remove_watermark=True)

    assert "remove visible platform watermarks" in prompt
    assert "especially corner marks" in prompt
