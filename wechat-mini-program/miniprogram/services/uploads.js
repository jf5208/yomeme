function fileExtension(filePath) {
  const extension = String(filePath).split(/[?#]/)[0].split(".").pop().toLowerCase();
  return extension === "jpeg" ? "jpg" : extension;
}

function uploadOne({ cloudPath, filePath, onProgress, onUploaded }) {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success({ fileID }) {
        Promise.resolve(onUploaded(fileID)).then(() => {
          onProgress(100);
          resolve(fileID);
        }, reject);
      },
      fail: reject,
    });
    if (task && typeof task.onProgressUpdate === "function") {
      task.onProgressUpdate(({ progress }) => onProgress(progress));
    }
  });
}

async function uploadGenerationFiles({
  jobId,
  templatePath,
  petPaths,
  onProgress = () => {},
  onUploaded = () => {},
}) {
  const paths = [templatePath, ...petPaths];
  const progressByFile = paths.map(() => 0);
  const report = (index, progress) => {
    progressByFile[index] = Math.max(0, Math.min(100, Number(progress) || 0));
    const total = progressByFile.reduce((sum, value) => sum + value, 0);
    onProgress(Math.round(total / progressByFile.length));
  };
  const cloudPaths = [
    `uploads/${jobId}/template.${fileExtension(templatePath)}`,
    ...petPaths.map((filePath, index) =>
      `uploads/${jobId}/pet-${index + 1}.${fileExtension(filePath)}`),
  ];

  const fileIds = await Promise.all(paths.map((filePath, index) => uploadOne({
    cloudPath: cloudPaths[index],
    filePath,
    onProgress: (progress) => report(index, progress),
    onUploaded,
  })));
  return {
    templateFileId: fileIds[0],
    petFileIds: fileIds.slice(1),
  };
}

module.exports = { uploadGenerationFiles };
