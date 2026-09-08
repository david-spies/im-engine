/**
 * @file ECS.js — Entity-Component-System core
 *
 * Entities are plain integer IDs.  Components are Plain Old Data objects
 * stored in typed arrays or flat object maps (no class instances per
 * entity — avoids per-frame GC pressure).  Systems are functions that
 * iterate a filtered view of entities.
 *
 * Object Pool: every component type owns a freelist so destroyed entities
 * donate their component slots back instead of triggering GC.
 */

export class World {
  constructor() {
    /** @type {number} */
    this._nextId = 1;
    /** @type {Set<number>} */
    this._alive = new Set();
    /** @type {Map<string, Map<number, object>>} */
    this._components = new Map();
    /** @type {Map<string, object[]>} freelist pools per component type */
    this._pools = new Map();
    /** @type {System[]} ordered list of registered systems */
    this._systems = [];
  }

  // ── Entity lifecycle ────────────────────────────────────────────────

  /** @returns {number} fresh entity id */
  create() {
    const id = this._nextId++;
    this._alive.add(id);
    return id;
  }

  /** Remove entity and return all component slots to their pools */
  destroy(id) {
    if (!this._alive.has(id)) return;
    for (const [type, store] of this._components) {
      if (store.has(id)) {
        const pool = this._pools.get(type);
        if (pool) pool.push(store.get(id));
        store.delete(id);
      }
    }
    this._alive.delete(id);
  }

  // ── Component storage ───────────────────────────────────────────────

  /**
   * Attach a component to an entity.
   * @param {number}   id        entity id
   * @param {string}   type      component name
   * @param {object}   data      component data (POD)
   */
  add(id, type, data) {
    if (!this._components.has(type)) {
      this._components.set(type, new Map());
      this._pools.set(type, []);
    }
    this._components.get(type).set(id, data);
    return data;
  }

  /** Retrieve a component by entity id and type, or null */
  get(id, type) {
    return this._components.get(type)?.get(id) ?? null;
  }

  /** Remove a single component from an entity */
  remove(id, type) {
    const store = this._components.get(type);
    if (!store?.has(id)) return;
    const pool = this._pools.get(type);
    if (pool) pool.push(store.get(id));
    store.delete(id);
  }

  /** True if entity has ALL listed component types */
  has(id, ...types) {
    return types.every(t => this._components.get(t)?.has(id));
  }

  /**
   * Iterate all entities that have every listed component type.
   * Returns a generator of [id, ...components] tuples.
   * @param  {...string} types
   */
  *query(...types) {
    // Use the smallest component store as the iteration base
    let smallest = null;
    for (const t of types) {
      const store = this._components.get(t);
      if (!store) return;
      if (!smallest || store.size < smallest.size) smallest = store;
    }
    if (!smallest) return;
    for (const [id] of smallest) {
      if (!this._alive.has(id)) continue;
      if (!types.every(t => this._components.get(t)?.has(id))) continue;
      yield [id, ...types.map(t => this._components.get(t).get(id))];
    }
  }

  // ── Pool utilities ───────────────────────────────────────────────────

  /**
   * Get a recycled component object from the pool (or create via factory).
   * @param {string}           type
   * @param {() => object}     factory
   */
  alloc(type, factory) {
    const pool = this._pools.get(type);
    if (pool?.length) return pool.pop();
    return factory();
  }

  // ── Systems ──────────────────────────────────────────────────────────

  /** @param {System} system */
  addSystem(system) {
    this._systems.push(system);
    system.world = this;
    if (system.init) system.init();
  }

  /**
   * Execute all registered systems in order.
   * @param {number} dt  delta-time in seconds
   * @param {object} ctx  shared frame context (renderer, input, audio…)
   */
  update(dt, ctx) {
    for (const sys of this._systems) {
      if (sys.active !== false) sys.update(dt, ctx);
    }
  }
}

/**
 * Base System class — extend and implement update(dt, ctx).
 * world is injected by World.addSystem().
 */
export class System {
  constructor() {
    /** @type {World} */
    this.world = null;
    this.active = true;
  }
  /** @param {number} dt @param {object} ctx */
  update(_dt, _ctx) {}
}
