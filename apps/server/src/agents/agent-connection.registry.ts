import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import type { ServerToAgentMessage } from '@buildplatform/contracts';

interface RegisteredConnection {
  readonly socket: WebSocket;
  ready: boolean;
}

/** 单 Server 实例内的 Agent 连接注册表，同时记录 hello 是否完成。 */
@Injectable()
export class AgentConnectionRegistry {
  private readonly connections = new Map<string, RegisteredConnection>();

  register(agentId: string, socket: WebSocket): WebSocket | undefined {
    const previous = this.connections.get(agentId)?.socket;
    this.connections.set(agentId, { socket, ready: false });
    return previous;
  }

  markReady(agentId: string, socket: WebSocket): boolean {
    const current = this.connections.get(agentId);
    if (!current || current.socket !== socket) return false;
    current.ready = true;
    return true;
  }

  get(agentId: string): WebSocket | undefined {
    return this.connections.get(agentId)?.socket;
  }

  disconnect(agentId: string, reason = 'connection closed'): boolean {
    const current = this.connections.get(agentId);
    if (!current) return false;
    this.connections.delete(agentId);
    try {
      if (
        current.socket.readyState === WebSocket.OPEN ||
        current.socket.readyState === WebSocket.CONNECTING
      ) {
        current.socket.close(1000, reason.slice(0, 120));
      }
    } catch {
      current.socket.terminate();
    }
    return true;
  }

  unregister(agentId: string, socket: WebSocket): boolean {
    if (this.connections.get(agentId)?.socket !== socket) return false;
    this.connections.delete(agentId);
    return true;
  }

  isConnected(agentId: string): boolean {
    const socket = this.connections.get(agentId)?.socket;
    return socket !== undefined && socket.readyState === WebSocket.OPEN;
  }

  isReady(agentId: string): boolean {
    const current = this.connections.get(agentId);
    return current !== undefined && current.ready && current.socket.readyState === WebSocket.OPEN;
  }

  send(agentId: string, message: ServerToAgentMessage): boolean {
    const current = this.connections.get(agentId);
    if (!current || !current.ready || current.socket.readyState !== WebSocket.OPEN) return false;
    try {
      current.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  entries(): ReadonlyArray<readonly [string, WebSocket]> {
    return Array.from(this.connections, ([agentId, current]) => [agentId, current.socket] as const);
  }
}
