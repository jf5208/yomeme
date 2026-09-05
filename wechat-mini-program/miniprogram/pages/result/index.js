const { callApi } = require("../../services/api");

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({ url, success: resolve, fail: reject });
  });
}

function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
  });
}

function toast(title) {
  wx.showToast({ title, icon: "none", duration: 2600 });
}

Page({
  data: {
    jobId: "",
    incomingToken: "",
    status: "loading",
    imageUrl: "",
    generatedAt: "",
    readOnly: true,
    canAdjust: false,
    shareToken: "",
    loading: true,
    saving: false,
    adjusting: false,
    adjustment: "",
  },

  onLoad(options = {}) {
    const jobId = String(options.jobId || "");
    const incomingToken = String(options.shareToken || "");
    this.setData({ jobId, incomingToken });
    return this.loadResult();
  },

  async loadResult() {
    if (!this.data.jobId) {
      this.setData({ loading: false, status: "missing" });
      toast("生成任务不存在");
      return;
    }
    this.setData({ loading: true });
    try {
      const payload = { jobId: this.data.jobId };
      if (this.data.incomingToken) payload.token = this.data.incomingToken;
      const response = await callApi("getResult", payload);
      const result = response.data || {};
      this.setData({
        status: result.status || "failed",
        imageUrl: result.imageUrl || "",
        generatedAt: result.generatedAt || "",
        readOnly: result.readOnly !== false,
        canAdjust: result.canAdjust === true,
      });
      if (result.status === "succeeded" && result.readOnly === false && !this.data.shareToken) {
        try {
          const shared = await callApi("prepareShare", { jobId: this.data.jobId });
          this.setData({ shareToken: (shared.data && shared.data.token) || "" });
        } catch (_error) {
          this.setData({ shareToken: "" });
        }
      }
    } catch (error) {
      this.setData({ status: "failed" });
      toast(error.message || "结果暂时无法读取");
    } finally {
      this.setData({ loading: false });
    }
  },

  onAdjustmentInput(event) {
    this.setData({ adjustment: event.detail.value });
  },

  async submitAdjustment() {
    const adjustment = this.data.adjustment.trim();
    if (
      this.data.adjusting
      || this.data.readOnly
      || !this.data.canAdjust
      || this.data.status !== "succeeded"
      || !adjustment
    ) return;

    this.setData({ adjusting: true });
    try {
      const prepared = await callApi("prepareGeneration");
      const jobId = prepared.data && prepared.data.jobId;
      if (!jobId) throw new Error("任务创建失败，请稍后再试。");
      await callApi("generate", {
        jobId,
        sourceJobId: this.data.jobId,
        adjustment,
        rightsConfirmed: true,
      });
      wx.navigateTo({ url: `/pages/result/index?jobId=${encodeURIComponent(jobId)}` });
    } catch (error) {
      toast(error.message || "生成失败，本次未扣积分");
    } finally {
      this.setData({ adjusting: false });
    }
  },

  async saveImage() {
    if (this.data.saving || !this.data.imageUrl) return;
    this.setData({ saving: true });
    try {
      const downloaded = await downloadFile(this.data.imageUrl);
      if (!downloaded || downloaded.statusCode !== 200 || !downloaded.tempFilePath) {
        throw new Error("图片下载失败");
      }
      await saveToAlbum(downloaded.tempFilePath);
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      const message = String((error && error.errMsg) || error.message || "");
      if (message.includes("auth deny") || message.includes("authorize")) {
        wx.showModal({
          title: "需要相册权限",
          content: "请在小程序右上角设置中允许保存到相册，然后再试一次。",
          showCancel: false,
        });
      } else {
        toast("保存失败，请稍后再试");
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  onShareAppMessage() {
    const query = this.data.shareToken
      ? `?jobId=${encodeURIComponent(this.data.jobId)}&shareToken=${encodeURIComponent(this.data.shareToken)}`
      : `?jobId=${encodeURIComponent(this.data.jobId)}`;
    return {
      title: "给你看看我家毛孩子的表情包",
      path: `/pages/result/index${query}`,
      imageUrl: this.data.imageUrl,
    };
  },
});
