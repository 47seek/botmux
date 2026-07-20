export const MCP_GATEWAY_OWNER_ENV = 'BOTMUX_MCP_GATEWAY';
export const MCP_GATEWAY_SESSION_ENV = 'BOTMUX_SESSION_ID';
export const MCP_GATEWAY_DATA_DIR_ENV = 'SESSION_DATA_DIR';
export const MCP_GATEWAY_SOCKET_ENV = 'BOTMUX_MCP_GATEWAY_SOCKET';
export const MCP_GATEWAY_REQUIRED_ENV = 'BOTMUX_MCP_GATEWAY_REQUIRED';

/** Environment copied by CLI-native MCP launchers from the owning Botmux CLI
 * process into the `botmux mcp serve` relay process. */
export const MCP_GATEWAY_FORWARDED_ENV_KEYS = [
  MCP_GATEWAY_SESSION_ENV,
  MCP_GATEWAY_DATA_DIR_ENV,
  MCP_GATEWAY_SOCKET_ENV,
  MCP_GATEWAY_REQUIRED_ENV,
] as const;
