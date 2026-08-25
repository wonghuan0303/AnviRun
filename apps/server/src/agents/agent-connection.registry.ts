import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/** 单 Server 实例内的 Agent 连接注册表。 */
@Injectable()
export class AgentConnectionRegistry {
  private readonly connections = new Map<string, WebSocket>();

  register(agentId: string, socket: WebSocket): WebSocket | undefined {
    const previous = this.connections.get(agentId);
    this.connections.set(agentId, socket);
    return previous;
  }

  get(agentId: string): WebSocket | undefined {
    return this.connections.get(agentId);
  }

  disconnect(agentId: string, reason = 'connection closed'): boolean {
    const socket = this.connections.get(agentId);
    if (!socket) return false;
    this.connections.delete(agentId);
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, reason.slice(0, 120));
      }
    } catch {
      socket.terminate();
    }
    return true;
  }

  unregister(agentId: string, socket: WebSocket): boolean {
    if (this.connections.get(agentId) !== socket) return false;
    this.connections.delete(agentId);
    return true;
  }

  isConnected(agentId: string): boolean {
    const socket = this.connections.get(agentId);
    return socket !== undefined && socket.readyState === WebSocket.OPEN;
  }

  entries(): ReadonlyArray<readonly [string, WebSocket]> {
    return Array.from(this.connections.entries());
  }
}
