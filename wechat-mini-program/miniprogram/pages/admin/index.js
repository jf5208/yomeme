const { callApi } = require("../../services/api");

function statusLabel(status) {
  return {
    unused: "未使用",
    redeemed: "已兑换",
    disabled: "已停用",
  }[status] || "未知";
}

function displayCode(item) {
  return { ...item, statusLabel: statusLabel(item.status) };
}

Page({
  data: {
    authorized: null,
    loading: true,
    creating: false,
    count: 1,
    credits: 1000,
    newCodes: [],
    codes: [],
  },

  onLoad() {
    return this.loadCodes();
  },

  async loadCodes() {
    this.setData({ loading: true });
    try {
      const response = await callApi("adminListCodes");
      this.setData({
        authorized: true,
        codes: (response.data || []).map(displayCode),
      });
    } catch (error) {
      if (error.code === "forbidden" || error.code === "admin_not_configured") {
        this.setData({ authorized: false, codes: [], newCodes: [] });
      } else {
        this.setData({ authorized: false, codes: [], newCodes: [] });
        wx.showToast({ title: error.message || "列表加载失败", icon: "none" });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  onCountInput(event) {
    this.setData({ count: Number(event.detail.value) });
  },

  onCreditsInput(event) {
    this.setData({ credits: Number(event.detail.value) });
  },

  async createCodes() {
    if (this.data.creating || !this.data.authorized) return;
    this.setData({ creating: true, newCodes: [] });
    try {
      const response = await callApi("adminCreateCodes", {
        count: this.data.count,
        credits: this.data.credits,
      });
      const created = (response.data || []).map(displayCode);
      const summaries = created.map(({ code, ...item }) => item);
      this.setData({ newCodes: created, codes: summaries.concat(this.data.codes) });
    } catch (error) {
      wx.showToast({ title: error.message || "充值码生成失败", icon: "none" });
    } finally {
      this.setData({ creating: false });
    }
  },

  copyCode(event) {
    const code = event.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success() { wx.showToast({ title: "已复制", icon: "success" }); },
    });
  },

  async disableCode(event) {
    const codeId = event.currentTarget.dataset.id;
    if (!codeId) return;
    try {
      const response = await callApi("adminDisableCode", { codeId });
      const updated = displayCode(response.data || {});
      this.setData({
        codes: this.data.codes.map((item) => item.codeId === codeId ? updated : item),
        newCodes: this.data.newCodes.filter((item) => item.codeId !== codeId),
      });
    } catch (error) {
      wx.showToast({ title: error.message || "停用失败", icon: "none" });
    }
  },
});
