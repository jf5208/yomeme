def build_generation_prompt(pet_count: int, adjustment: str, remove_watermark: bool = False, low_quality: bool = False) -> str:
    prompt = f"""Use the first image as the original single-animal Meme template.
Use the next {pet_count} pet reference photos as the SOLE identity reference for the user's real pet.

CRITICAL - Three Rules:

Rule 1 - PHOTOREALISTIC STYLE (MOST IMPORTANT):
- The generated pet MUST be PHOTOREALISTIC, like a real photograph of a real animal.
- NEVER generate cartoon, 3D render, illustration, drawing, anime, or stylized art.
- Even if the template is cartoon/3D/illustrated, the generated pet MUST be photorealistic.
- The reference photos are real pet photos, so the output must match that photorealistic style.

Rule 2 - BODY SHAPE FROM TEMPLATE:
- Preserve the original animal's BODY SHAPE, SIZE, POSTURE, POSE, and overall silhouette.
- If the template animal is round, chubby, or has a specific body shape, the generated pet MUST have the same body shape.

Rule 3 - IDENTITY FROM PET PHOTOS:
- Preserve the pet's REAL identity features: fur color, fur pattern, face markings, eye color, ear shape, and nose features.

The generated pet = Photorealistic style + Template's body shape + Pet's identity features.

Goal:
Replace ONLY the single animal subject in the Meme template with the user's pet.

Strict preservation requirements:
- preserve all original visible text exactly; do not rewrite, translate, move, or restyle it.
- preserve the original composition, camera angle, pose, expression, action, body language, crop, and framing.
- preserve the Meme template's canvas shape and orientation; pet reference photos must never change the output aspect ratio.
- preserve the background, lighting direction, shadows, rough edges, transparency, blur, compression artifacts, low-resolution web-image texture, and screenshot-like quality.
- keep the result feeling like the same internet Meme image, not a polished poster or studio illustration.
- do not add extra animals, people, decorations, captions, logos, stickers, or story elements."""

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
