const form = document.querySelector("#generate-form");
const templateInput = document.querySelector("#template");
const petsInput = document.querySelector("#pets");
const templatePreview = document.querySelector("#template-preview");
const resultPreview = document.querySelector("#result-preview");
const statusText = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");
const downloadLink = document.querySelector("#download-link");
const templateWidth = document.querySelector("#template-width");
const templateHeight = document.querySelector("#template-height");
const templateRatio = document.querySelector("#template-ratio");
const inviteFields = document.querySelector("#invite-fields");
const inviteCode = document.querySelector("#invite-code");
const verifyInvite = document.querySelector("#verify-invite");
const inviteStatus = document.querySelector("#invite-status");

function describeInvite(remainingUses) {
  return `邀请码已验证，剩余 ${remainingUses} 积分。`;
}

verifyInvite.addEventListener("click", async () => {
  const code = inviteCode.value.trim();
  if (!code) {
    inviteStatus.textContent = "请先填写邀请码。";
    return;
  }

  verifyInvite.disabled = true;
  inviteStatus.textContent = "正在验证邀请码...";
  try {
    const response = await fetch("/api/invite/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "邀请码验证失败。");
    }
    inviteStatus.textContent = describeInvite(payload.remaining_uses);
  } catch (error) {
    inviteStatus.textContent = error.message;
  } finally {
    verifyInvite.disabled = false;
  }
});

templateInput.addEventListener("change", () => {
  const [file] = templateInput.files;
  if (!file) {
    templatePreview.removeAttribute("src");
    templateWidth.value = "";
    templateHeight.value = "";
    templateRatio.textContent = "等待模板";
    return;
  }
  templatePreview.src = URL.createObjectURL(file);
});

templatePreview.addEventListener("load", () => {
  templateWidth.value = String(templatePreview.naturalWidth);
  templateHeight.value = String(templatePreview.naturalHeight);
  const ratio = Math.max(templatePreview.naturalWidth, templatePreview.naturalHeight) / Math.min(templatePreview.naturalWidth, templatePreview.naturalHeight);
  const isSquare = ratio <= 1.5;
  templateRatio.textContent = isSquare ? "正方形模板" : "比例不符合要求";
  templateRatio.classList.toggle("invalid", !isSquare);
});

petsInput.addEventListener("change", () => {
  if (petsInput.files.length > 3) {
    statusText.textContent = "宠物照片最多上传 3 张。";
    petsInput.value = "";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!templateInput.files.length) {
    statusText.textContent = "请上传 1 张单动物 Meme 模板图。";
    return;
  }
  if (petsInput.files.length < 1 || petsInput.files.length > 3) {
    statusText.textContent = "请上传 1 到 3 张自家宠物照片。";
    return;
  }
  if (!templateWidth.value || !templateHeight.value) {
    statusText.textContent = "正在读取 Meme 模板比例，请稍后再生成。";
    return;
  }
  const w = Number(templateWidth.value);
  const h = Number(templateHeight.value);
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 1.5) {
    statusText.textContent = "Meme 模板必须是接近正方形的图片（宽高比不超过 1.5），请重新上传。";
    return;
  }
  if (!inviteCode.value.trim()) {
    statusText.textContent = "请填写邀请码。";
    inviteStatus.textContent = "请填写邀请码。";
    return;
  }
  const formData = new FormData(form);
  submitButton.disabled = true;
  submitButton.textContent = "生成中...";
  statusText.textContent = "正在生成";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "生成失败，请稍后再试。");
    }
    const cacheBuster = `t=${Date.now()}`;
    resultPreview.src = `${payload.image_url}?${cacheBuster}`;
    downloadLink.href = payload.download_url;
    downloadLink.hidden = false;
    submitButton.textContent = "按调整意见再生成";
    if (Object.prototype.hasOwnProperty.call(payload, "remaining_uses")) {
      inviteStatus.textContent = describeInvite(payload.remaining_uses);
      statusText.textContent = `图片已生成，邀请码剩余 ${payload.remaining_uses} 积分。`;
    } else {
      statusText.textContent = "图片已生成。可以下载，或输入调整意见后再次生成。";
    }
  } catch (error) {
    statusText.textContent = error.message;
    submitButton.textContent = resultPreview.getAttribute("src") ? "按调整意见再生成" : "生成 Meme";
  } finally {
    submitButton.disabled = false;
  }
});
