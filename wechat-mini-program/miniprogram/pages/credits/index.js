const { callApi } = require("../../services/api");

Page({
  data: {
    credits: 0,
    code: "",
    loading: true,
    redeeming: false,
    redeemedCredits: 0,
  },

  onShow() {
    return this.refreshBalance();
  },

  async refreshBalance() {
    this.setData({ loading: true });
    try {
      const response = await callApi("bootstrap");
      const credits = Number((response.data && response.data.credits) || 0);
      this.setData({ credits });
      getApp().globalData.credits = credits;
    } catch (error) {
      wx.showToast({ title: error.message || "积分加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCodeInput(event) {
    this.setData({ code: event.detail.value, redeemedCredits: 0 });
  },

  async redeem() {
    if (this.data.redeeming) return;
    const code = this.data.code.trim();
    if (!code) {
      wx.showToast({ title: "请先填写充值码", icon: "none" });
      return;
    }

    const before = this.data.credits;
    this.setData({ redeeming: true });
    try {
      const response = await callApi("redeem", { code });
      const credits = Number((response.data && response.data.credits) || before);
      this.setData({
        credits,
        code: "",
        redeemedCredits: Math.max(0, credits - before),
      });
      getApp().globalData.credits = credits;
      wx.showToast({ title: "积分已到账", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "兑换失败，请检查充值码", icon: "none" });
    } finally {
      this.setData({ redeeming: false });
    }
  },
});
