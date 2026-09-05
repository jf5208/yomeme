const { callApi } = require("../../services/api");
const { uploadGenerationFiles } = require("../../services/uploads");
const { isSupportedImage, isSquareImage, validatePetCount } = require("../../utils/image");

function chooseImages(options) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      ...options,
      success: resolve,
      fail: reject,
    });
  });
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject });
  });
}

function isCancelled(error) {
  return String((error && error.errMsg) || "").includes("cancel");
}

Page({
  data: {
    template: null,
    pets: [],
    rightsConfirmed: false,
    submitting: false,
    uploadProgress: 0,
  },

  async chooseTemplate() {
    try {
      const { tempFiles = [] } = await chooseImages({ count: 1, mediaType: ["image"] });
      const selected = tempFiles[0];
      if (!selected) return;

      const imagePath = selected.tempFilePath;
      if (!isSupportedImage(imagePath)) {
        this.setData({ template: null });
        wx.showToast({ title: "仅支持 PNG、JPG 或 WebP 图片", icon: "none" });
        return;
      }

      const { width, height } = await getImageInfo(imagePath);
      if (!isSquareImage(width, height)) {
        this.setData({ template: null });
        wx.showToast({ title: "请先裁成 1:1，本次不扣积分", icon: "none", duration: 2600 });
        return;
      }

      this.setData({ template: { path: imagePath, width, height } });
    } catch (error) {
      if (!isCancelled(error)) {
        wx.showToast({ title: "图片读取失败，请重新选择", icon: "none" });
      }
    }
  },

  async choosePets() {
    const remaining = 3 - this.data.pets.length;
    if (remaining <= 0) {
      wx.showToast({ title: "宠物照片最多上传 3 张。", icon: "none" });
      return;
    }

    try {
      const { tempFiles = [] } = await chooseImages({ count: remaining, mediaType: ["image"] });
      const supportedPets = tempFiles
        .filter(({ tempFilePath }) => isSupportedImage(tempFilePath))
        .slice(0, remaining)
        .map(({ tempFilePath }) => ({ path: tempFilePath }));

      if (supportedPets.length !== tempFiles.slice(0, remaining).length) {
        wx.showToast({ title: "已跳过不支持的图片格式", icon: "none" });
      }
      this.setData({ pets: this.data.pets.concat(supportedPets) });
    } catch (error) {
      if (!isCancelled(error)) {
        wx.showToast({ title: "照片读取失败，请重新选择", icon: "none" });
      }
    }
  },

  removePet(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ pets: this.data.pets.filter((_, petIndex) => petIndex !== index) });
  },

  toggleRights(event) {
    this.setData({ rightsConfirmed: event.detail.value.includes("confirmed") });
  },

  async submitGeneration() {
    if (this.data.submitting) return;

    const petValidation = validatePetCount(this.data.pets.length);
    if (!this.data.template || !petValidation.ok || !this.data.rightsConfirmed) {
      wx.showToast({
        title: !petValidation.ok ? petValidation.message : "请完成模板、照片和素材确认",
        icon: "none",
      });
      return;
    }

    this.setData({ submitting: true, uploadProgress: 0 });
    try {
      const prepared = await callApi("prepareGeneration");
      const jobId = prepared.data && prepared.data.jobId;
      if (!jobId) throw new Error("任务创建失败，请稍后再试。");

      const template = this.data.template;
      const { templateFileId, petFileIds } = await uploadGenerationFiles({
        jobId,
        templatePath: template.path,
        petPaths: this.data.pets.map(({ path }) => path),
        onProgress: (uploadProgress) => this.setData({ uploadProgress }),
      });

      await callApi("generate", {
        jobId,
        templateFileId,
        petFileIds,
        templateWidth: template.width,
        templateHeight: template.height,
        rightsConfirmed: true,
      });
      wx.navigateTo({ url: `/pages/result/index?jobId=${encodeURIComponent(jobId)}` });
    } catch (error) {
      wx.showToast({ title: error.message || "生成失败，本次不扣积分", icon: "none", duration: 2600 });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
