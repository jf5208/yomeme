def build_generation_prompt(pet_count: int, adjustment: str, remove_watermark: bool = False, low_quality: bool = False) -> str:
    prompt = f"""Use the first image as the original single-animal Meme template.
Use the next {pet_count} pet reference photos as the SOLE identity reference for the user's real pet.

CRITICAL - Pet Identity Preservation:
- The generated pet MUST be the user's actual pet from the reference photos, not a generic similar animal.
- Strictly preserve the pet's REAL characteristics: fur color, fur pattern, face shape, eye color, ear shape, nose features, and fur length.
- Do NOT replace the user's pet with a different breed, color, or style that merely looks similar.
- Do NOT auto-correct or "improve" the pet's appearance into a different variety.

Goal:
Replace ONLY the single animal subject in the Meme template with the user's pet, keeping the pet's true identity intact.

Strict preservation requirements:
- preserve all original visible text exactly; do not rewrite, translate, move, or restyle it.
- preserve the original composition, camera angle, pose, expression, action, body language, crop, and framing.
- preserve the Meme template's canvas shape and orientation; pet reference photos must never change the output aspect ratio.
- preserve the background, lighting direction, shadows, rough edges, transparency, blur, compression artifacts, low-resolution web-image texture, and screenshot-like quality.
- keep the result feeling like the same internet Meme image, not a polished poster or studio illustration.
- do not add extra animals, people, decorations, captions, logos, stickers, or story elements.
- adapt the pet to fit the original animal's position and action in the frame, but NEVER alter the pet's core identity features.
- if the template is an illustration or low-quality image, preserve the template's composition and visual texture while retaining the user's pet identity."""

    if low_quality:
        prompt += """

Low quality style requirements (IMPORTANT):
- intentionally reduce image clarity and sharpness
- add visible JPEG compression artifacts and blockiness
- make the image look like a low-resolution screenshot or heavily compressed web image
- reduce fine details, make fur texture blurry and indistinct
- overall look should be deliberately low-quality, like a meme that has been re-saved many times
- do NOT produce a clean, high-definition, or polished result"""

    if remove_watermark:
        prompt += "\n- remove visible platform watermarks from the original template, especially corner marks, and reconstruct only the affected background; do not remove user-added Meme captions."

    cleaned_adjustment = adjustment.strip()
    if cleaned_adjustment:
        prompt += f"\n\nUser adjustment for this regeneration:\n{cleaned_adjustment}"
    return prompt
