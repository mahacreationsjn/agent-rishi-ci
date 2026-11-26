/** IPC channels between the preload bridge and the main process. */
export const CHANNELS = {
  info: "agent-rishi:info",
  pickFolder: "agent-rishi:pick-folder",
  notify: "agent-rishi:notify",
  notificationClick: "agent-rishi:notification-click",
  openExternal: "agent-rishi:open-external",
  setBadge: "agent-rishi:set-badge",
  navigate: "agent-rishi:navigate",
  browserShow: "agent-rishi:browser-show",
  browserHide: "agent-rishi:browser-hide",
  browserCapture: "agent-rishi:browser-capture",
  browserInspect: "agent-rishi:browser-inspect",
  browserShortcut: "agent-rishi:browser-shortcut",
} as const;
