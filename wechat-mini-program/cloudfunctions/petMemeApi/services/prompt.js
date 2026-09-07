function buildPrompt(petCount, adjustment) {
  const petImageEnd = petCount + 1;
  const identityReference = petCount === 1
    ? "Image 2 is the sole identity reference for the user's real pet."
    : `Images 2 through ${petImageEnd} are the sole identity references for the user's real pet.`;

  let prompt = `Image 1 is the original single-animal Meme template.
${identityReference}

CRITICAL - Three Rules:

Rule 1 - PHOTOREALISTIC STYLE (MOST IMPORTANT):
- The generated pet MUST be PHOTOREALISTIC, like a real photograph of a real animal.
- NEVER generate cartoon, 3D render, illustration, drawing, anime, or stylized art.
- Even if the template is cartoon, 3D, or illustrated, the generated pet MUST be photorealistic.
- The pet reference photos show the real pet, so the output must match that photorealistic identity.

Rule 2 - BODY SHAPE FROM TEMPLATE:
- Preserve the original animal's BODY SHAPE, SIZE, POSTURE, POSE, and overall silhouette.
- If the template animal is round, chubby, or has a specific body shape, the generated pet MUST have the same body shape.

Rule 3 - IDENTITY FROM PET PHOTOS:
- Preserve the pet's real identity features: fur color, fur pattern, face markings, eye color, ear shape, and nose features.

The generated pet = photorealistic style + template body shape + pet identity features.

Goal:
Replace only the single animal subject in Image 1 with the user's pet from the later reference images.

Strict preservation requirements:
- preserve all original visible text exactly; do not rewrite, translate, move, or restyle it.
- preserve the original composition, camera angle, pose, expression, action, body language, crop, and framing.
- output a square 1:1 image; pet reference photos must never change the output aspect ratio.
- preserve the background, lighting direction, shadows, rough edges, transparency, blur, compression artifacts, low-resolution web-image texture, and screenshot-like quality.
- keep the result feeling like the same internet Meme image, not a polished poster or studio illustration.
- do not add extra animals, people, decorations, captions, logos, stickers, or story elements.`;

  const cleanedAdjustment = String(adjustment || "").trim();
  if (cleanedAdjustment) {
    prompt += `\n\nUser adjustment for this regeneration:\n${cleanedAdjustment}`;
  }

  return prompt;
}

module.exports = { buildPrompt };
