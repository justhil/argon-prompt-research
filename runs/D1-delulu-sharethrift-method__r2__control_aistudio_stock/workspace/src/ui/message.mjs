// Exact type contract from microsoft/delulu typescript-method-76743897a697:
// '{ success: MessageFunc; error: MessageFunc; info: MessageFunc; loading: MessageFunc; config: (options: { top: number; }) => void; destroy: () => void; }'
// Note: Property 'notifyLimit' does NOT exist on message! Golden uses message.info(...)
export const message = {
  logs: [],
  success(text) { this.logs.push({ level: 'success', text }); },
  error(text) { this.logs.push({ level: 'error', text }); },
  info(text) { this.logs.push({ level: 'info', text }); },
  loading(text) { this.logs.push({ level: 'loading', text }); },
  config(_opts) {},
  destroy() { this.logs = []; }
};
