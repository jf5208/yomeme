function invalidInput(message) {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

function cloudFileId(value) {
  return typeof value === "string" && /^cloud:\/\/\S+$/.test(value.trim());
}

function validateGenerationInput(event) {
  if (!event || typeof event.jobId !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(event.jobId)) {
    throw invalidInput("生成任务编号无效。");
  }
  if (!cloudFileId(event.templateFileId)) {
    throw invalidInput("模板文件无效。");
  }
  if (
    !Array.isArray(event.petFileIds)
    || event.petFileIds.length < 1
    || event.petFileIds.length > 3
    || event.petFileIds.some((fileId) => !cloudFileId(fileId))
  ) {
    throw invalidInput("请上传 1 到 3 张宠物照片。");
  }
  if (event.rightsConfirmed !== true) {
    throw invalidInput("请先确认素材权利。");
  }

  const adjustment = event.adjustment === undefined ? "" : event.adjustment;
  if (typeof adjustment !== "string" || Array.from(adjustment).length > 300) {
    throw invalidInput("调整意见最多 300 字。");
  }

  return {
    fileIds: [event.templateFileId.trim(), ...event.petFileIds.map((fileId) => fileId.trim())],
    adjustment: adjustment.trim(),
  };
}

module.exports = { validateGenerationInput };
