import {
  MAX_AGENT_WS_MESSAGE_BYTES as CONTRACT_MAX_AGENT_WS_MESSAGE_BYTES,
  MAX_CLIENT_WS_MESSAGE_BYTES as CONTRACT_MAX_CLIENT_WS_MESSAGE_BYTES,
} from '@buildplatform/contracts';

/**
 * Small, explicit payload limits for the trusted-intranet deployment.
 * Artifact content is intentionally excluded because it uses a streaming
 * endpoint with its own manifest and byte limits.
 */
export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_URLENCODED_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_AGENT_WS_MESSAGE_BYTES = CONTRACT_MAX_AGENT_WS_MESSAGE_BYTES;
export const MAX_CLIENT_WS_MESSAGE_BYTES = CONTRACT_MAX_CLIENT_WS_MESSAGE_BYTES;
