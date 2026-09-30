// Keep native requests in the host's helper, so TCC checks the same identity as
// Computer Use. Electron only opens the exact settings page and follows return.
const panes = {
  screen: ["屏幕录制", "Privacy_ScreenCapture"],
  accessibility: ["辅助功能", "Privacy_Accessibility"],
  inputMonitoring: ["输入监控", "Privacy_ListenEvent"],
};
function createPermissionFlow({ request, openExternal, report }) {
  let waiting,
    running,
    generation = 0;
  function check(fromFocus = false) {
    if (running) return running;
    if (fromFocus && !waiting) return Promise.resolve();
    const current = generation;
    running = (async () => {
      let status = await request("/desktop/permissions", "POST", {});
      const missing = () =>
        Object.keys(panes).filter((key) => !status.permissions[key]);
      const finish = (message) => {
        const result = { ...status, message };
        if (current === generation) report(result);
        return result;
      };
      if (current !== generation) return;
      if (status.platform !== "darwin") {
        waiting = undefined;
        return finish(
          missing().length
            ? "系统检测未通过。Windows 普通桌面操作没有统一授权开关；请确认处于已解锁的交互桌面。管理员窗口和 UAC 安全桌面可能无法操作。"
            : "系统检测通过，无需额外授权。",
        );
      }
      if (fromFocus && waiting && !status.permissions[waiting])
        return finish(
          `“${panes[waiting][0]}”尚未授权。在系统设置中开启 Bro 后返回即可；若系统要求，请退出并重新打开 Bro。`,
        );
      waiting = undefined;
      for (const key of missing()) {
        status = await request("/desktop/permissions", "POST", {
          permission: key,
        });
        if (current !== generation) return;
        if (status.permissions[key]) continue;
        waiting = key;
        await openExternal(
          `x-apple.systempreferences:com.apple.preference.security?${panes[key][1]}`,
        );
        return finish(
          `已打开“${panes[key][0]}”，请开启 Bro；返回后自动检查并继续下一项授权。若系统要求，请退出并重新打开 Bro。`,
        );
      }
      return finish(
        status.restartRequired
          ? "系统权限已授予。点击“应用授权”重启后台，使权限生效；会话会保留。"
          : "系统权限已就绪。",
      );
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  return {
    check,
    cancel() {
      generation++;
      waiting = undefined;
    },
  };
}
module.exports = { createPermissionFlow };
