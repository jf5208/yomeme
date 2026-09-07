App({
  onLaunch() {
    if (wx.cloud) wx.cloud.init({ traceUser: true });
  },
  globalData: { credits: 0, userReady: false },
});
