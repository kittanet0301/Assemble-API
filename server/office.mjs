import {
  WORLD,
  ROOMS,
  STATUSES,
  DESKS,
  canStand,
  canStep,
  movementDirection,
  nextGridPoint,
  snapToGrid,
  findPath,
  roomAt,
  roomById,
  seatPosition,
} from '../shared/world.js';

export class Office {
  constructor(
    store,
    { maxOnline = 20, roomCapacity = 8, removeMediaParticipant = async () => {} } = {},
  ) {
    this.store = store;
    this.maxOnline = maxOnline;
    this.roomCapacity = roomCapacity;
    this.peers = new Map();
    this.removeMediaParticipant = removeMediaParticipant;
    this.time = Date.now();
  }
  connect(user, send, close, valid) {
    const old = this.peers.get(user.id);
    if (!old && this.peers.size >= this.maxOnline)
      throw new Error('ออฟฟิศเต็มชั่วคราว กรุณาลองใหม่อีกสักครู่');
    if (user.role === 'guest' && !this.hasRoomSpace(old, user.roomScope))
      throw new Error('ห้องประชุมเต็มแล้ว');
    if (old) {
      this.peers.delete(user.id);
      old.close(4001, 'เปิดใช้งานจากหน้าต่างอื่นแล้ว');
    }
    const spawn = user.role === 'guest' ? roomById(user.roomScope)?.entry : WORLD.spawn;
    if (!spawn) throw new Error('ไม่พบห้องประชุม');
    const point = snapToGrid(old ?? spawn);
    const peer = {
      user,
      ...point,
      roomId: user.role === 'guest' ? user.roomScope : (old?.roomId ?? null),
      dx: 0,
      dy: 0,
      path: [],
      motion: null,
      direction: 'down',
      inputAt: 0,
      send,
      close,
      valid,
    };
    this.peers.set(user.id, peer);
    this.broadcast();
    return peer;
  }
  disconnect(peer) {
    if (this.peers.get(peer.user.id) !== peer) return;
    this.peers.delete(peer.user.id);
    if (peer.roomId) void this.removeMediaParticipant(peer.roomId, peer.user.id);
    this.broadcast();
  }
  occupancy(id) {
    return [...this.peers.values()].filter((p) => p.roomId === id);
  }
  hasRoomSpace(peer, id) {
    return (
      [...this.peers.values()].filter(
        (p) => p !== peer && (p.roomId === id || p.motion?.roomId === id),
      ).length < this.roomCapacity
    );
  }
  visibleChannel(peer, channel) {
    return (
      typeof channel === 'string' &&
      (channel === 'general'
        ? peer.user.role !== 'guest'
        : !!roomById(channel) && channel === peer.roomId)
    );
  }
  snapshot(forPeer) {
    const peers = [...this.peers.values()].filter(
      (p) => forPeer.user.role !== 'guest' || p.roomId === forPeer.user.roomScope,
    );
    const directory =
      forPeer.user.role === 'guest'
        ? []
        : this.store
            .members()
            .filter((m) => !m.revoked)
            .map((m) => ({
              id: m.id,
              name: m.name,
              avatar: m.avatar,
              appearance: m.appearance,
              status: m.status,
              seat: m.seat,
              role: m.role,
            }));
    return {
      type: 'snapshot',
      serverTime: this.time,
      selfId: forPeer.user.id,
      peers: peers.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        role: p.user.role,
        avatar: p.user.avatar,
        appearance: p.user.appearance,
        status: p.user.status,
        seat: p.user.seat,
        x: p.x,
        y: p.y,
        motion: p.motion,
        roomId: p.roomId,
        direction: p.direction,
        moving: !!p.motion,
      })),
      directory,
      rooms: ROOMS.filter(
        (r) => forPeer.user.role !== 'guest' || r.id === forPeer.user.roomScope,
      ).map((r) => ({ ...r, capacity: this.roomCapacity, count: this.occupancy(r.id).length })),
    };
  }
  broadcast() {
    for (const peer of this.peers.values()) peer.send(this.snapshot(peer));
  }
  relocate(peer, point) {
    const snapped = snapToGrid(point);
    if (!canStand(snapped.x, snapped.y)) throw new Error('จุดหมายนี้มีวัตถุขวางอยู่');
    Object.assign(peer, snapped);
    peer.motion = null;
    peer.path = [];
    peer.dx = 0;
    peer.dy = 0;
  }
  changeRoom(peer, roomId) {
    if (peer.roomId === roomId) return;
    const old = peer.roomId;
    peer.roomId = roomId;
    if (old) void this.removeMediaParticipant(old, peer.user.id);
    if (roomId)
      void this.store
        .history(roomId)
        .then((messages) => {
          if (peer.roomId === roomId) peer.send({ type: 'history', channel: roomId, messages });
        })
        .catch(() => peer.send({ type: 'error', text: 'โหลดประวัติแชตไม่สำเร็จ' }));
  }
  startStep(peer, startedAt = this.time) {
    if (peer.motion || peer.user.role === 'guest') return false;
    const target = peer.path[0] ?? nextGridPoint(peer, peer.dx, peer.dy);
    if (!canStep(peer, target)) {
      peer.path = [];
      return false;
    }
    const roomId = roomAt(target)?.id ?? null;
    if (roomId && peer.roomId !== roomId && !this.hasRoomSpace(peer, roomId)) {
      peer.path = [];
      return false;
    }
    peer.direction =
      target.x > peer.x ? 'right' : target.x < peer.x ? 'left' : target.y > peer.y ? 'down' : 'up';
    peer.motion = {
      from: { x: peer.x, y: peer.y },
      to: { ...target },
      startedAt,
      durationMs: (Math.hypot(target.x - peer.x, target.y - peer.y) / WORLD.speed) * 1000,
      roomId,
    };
    if (peer.path.length) peer.path.shift();
    return true;
  }
  join(peer, roomId) {
    const room = roomById(roomId);
    if (!room || (peer.user.role === 'guest' && peer.user.roomScope !== roomId))
      throw new Error('ไม่มีสิทธิ์เข้าห้องนี้');
    if (!this.hasRoomSpace(peer, roomId))
      throw new Error(`ห้องนี้ครบ ${this.roomCapacity} คนแล้ว ลองอีกห้องได้เลย`);
    this.relocate(peer, room.entry);
    this.changeRoom(peer, roomId);
    this.broadcast();
  }
  leave(peer) {
    if (peer.user.role === 'guest') throw new Error('คำเชิญนี้ใช้ได้เฉพาะห้องประชุมที่ได้รับเชิญ');
    this.relocate(peer, WORLD.spawn);
    this.changeRoom(peer, null);
    this.broadcast();
  }
  async handle(peer, message) {
    if (!peer.valid()) {
      peer.close(4003, 'เซสชันหมดอายุหรือถูกถอนสิทธิ์');
      this.disconnect(peer);
      return;
    }
    switch (message.type) {
      case 'move': {
        if (peer.user.role === 'guest') return;
        if (!Number.isFinite(message.dx) || !Number.isFinite(message.dy)) return;
        Object.assign(peer, movementDirection(message.dx, message.dy));
        peer.path = [];
        peer.inputAt = Date.now();
        // Start on keydown, so a quick press/release between ticks still moves one cell.
        if (this.startStep(peer)) this.broadcast();
        break;
      }
      case 'walk': {
        if (
          peer.user.role === 'guest' ||
          !Number.isFinite(message.x) ||
          !Number.isFinite(message.y)
        )
          return;
        peer.dx = 0;
        peer.dy = 0;
        peer.path = findPath(peer.motion?.to ?? peer, { x: message.x, y: message.y });
        if (this.startStep(peer)) this.broadcast();
        break;
      }
      case 'status': {
        if (peer.user.role === 'guest' || !Object.hasOwn(STATUSES, message.status)) return;
        await this.store.setStatus(peer.user.id, message.status);
        peer.user.status = message.status;
        this.broadcast();
        break;
      }
      case 'join':
        this.join(peer, message.roomId);
        break;
      case 'leave':
        this.leave(peer);
        break;
      case 'history': {
        if (!this.visibleChannel(peer, message.channel)) throw new Error('ไม่มีสิทธิ์อ่านแชตนี้');
        peer.send({
          type: 'history',
          channel: message.channel,
          messages: await this.store.history(message.channel),
        });
        break;
      }
      case 'chat': {
        if (!this.visibleChannel(peer, message.channel)) throw new Error('เข้าห้องก่อนส่งข้อความ');
        if (typeof message.text !== 'string') return;
        const text = message.text.trim().slice(0, 1500);
        if (!text) return;
        if (Date.now() - (peer.lastChat ?? 0) < 600)
          throw new Error('ส่งข้อความเร็วเกินไป กรุณารอสักครู่');
        peer.lastChat = Date.now();
        const chat = await this.store.addMessage(peer.user, message.channel, text);
        for (const recipient of this.peers.values())
          if (this.visibleChannel(recipient, message.channel))
            recipient.send({ type: 'chat', message: chat });
        break;
      }
      case 'seat': {
        if (peer.user.role === 'guest' || !DESKS.some((d) => d.id === message.seat)) return;
        await this.store.setSeat(peer.user.id, message.seat);
        peer.user.seat = message.seat;
        this.broadcast();
        peer.send({ type: 'notice', text: `จองที่นั่ง ${message.seat} ให้คุณแล้ว` });
        break;
      }
      case 'myseat': {
        if (peer.user.role === 'guest') return;
        const point = seatPosition(peer.user.seat);
        if (!point) throw new Error('คลิกโต๊ะบนแผนที่เพื่อเลือกที่นั่งประจำก่อน');
        this.relocate(peer, point);
        this.changeRoom(peer, null);
        this.broadcast();
        break;
      }
      case 'reaction': {
        if (!['👋', '💚', '✨', '☕', '👏'].includes(message.emoji)) return;
        if (Date.now() - (peer.lastReaction ?? 0) < 1000) return;
        peer.lastReaction = Date.now();
        for (const p of this.peers.values())
          if (p.user.role !== 'guest' || p.roomId === peer.roomId)
            p.send({ type: 'reaction', userId: peer.user.id, emoji: message.emoji });
        break;
      }
    }
  }
  tick(dt) {
    const start = this.time;
    this.time += Math.max(0, Math.min(dt, 0.1)) * 1000;
    for (const peer of [...this.peers.values()]) {
      if (!peer.valid()) {
        peer.close(4003, 'เซสชันหมดอายุหรือถูกถอนสิทธิ์');
        this.disconnect(peer);
        continue;
      }
      if (Date.now() - peer.inputAt > 350) {
        peer.dx = 0;
        peer.dy = 0;
      }
      this.startStep(peer, start);
      // Carry surplus time into the following cell, without pausing at each center.
      while (peer.motion && peer.motion.startedAt + peer.motion.durationMs <= this.time) {
        const completed = peer.motion;
        Object.assign(peer, completed.to);
        peer.motion = null;
        this.changeRoom(peer, completed.roomId);
        this.startStep(peer, completed.startedAt + completed.durationMs);
      }
    }
  }
}
