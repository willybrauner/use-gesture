import { Controller } from '../Controller'
import { EventStore } from '../EventStore'
import { TimeoutStore } from '../TimeoutStore'
import { getEventDetails } from '../utils/events'
import { call } from '../utils/fn'
import { V, rubberbandIfOutOfBounds } from '../utils/maths'
import { GestureKey, Handler, IngKey, InternalConfig, State, Vector2 } from '../types'

export interface EngineConstructor {
  new <Key extends GestureKey>(ctrl: Controller, args: any[], key: Key): Engine<Key>
}

export interface Engine<Key extends GestureKey = GestureKey> {
  ctrl: Controller
  key: Key
  ingKey: IngKey
  args: any[]
  state: NonNullable<State[Key]>
  shared: State['shared']
  config: NonNullable<InternalConfig[Key]>
  sharedConfig: InternalConfig['shared']
  eventStore: EventStore
  timeoutStore: TimeoutStore
  handler: Handler<Key>
  init?(this: Engine<Key>): void
  setup?(this: Engine<Key>): void
  intent?(this: Engine<Key>, movement: Vector2): void
  reset(this: Engine<Key>): void
  start(this: Engine<Key>, event: NonNullable<State[Key]>['event']): void
  compute(this: Engine<Key>, event?: NonNullable<State[Key]>['event']): void
  computeOffset(this: Engine<Key>): void
  computeMovement(this: Engine<Key>): void
  emit(this: Engine<Key>): void
  clean(this: Engine<Key>): void
  bind(
    this: Engine<Key>,
    bindFunction: (
      device: string,
      action: string,
      handler: (event: any) => void,
      options?: AddEventListenerOptions
    ) => void
  ): void
}

export const Engine: EngineConstructor = function <Key extends GestureKey>(
  this: Engine<Key>,
  ctrl: Controller,
  args: any[],
  key: Key
) {
  this.ctrl = ctrl
  this.key = key
  this.args = args

  if (!this.state) {
    this.state = {
      values: [0, 0],
      initial: [0, 0]
    } as any
    if (this.init) this.init()
    this.reset()
  }
} as any

Engine.prototype = {
  get state() {
    return this.ctrl.state[this.key]
  },
  set state(state) {
    this.ctrl.state[this.key] = state
  },
  get shared() {
    return this.ctrl.state.shared
  },
  get eventStore() {
    return this.ctrl._gestureEventStores[this.key]
  },
  get timeoutStore() {
    return this.ctrl._gestureTimeoutStores[this.key]
  },
  get config() {
    return this.ctrl._config[this.key]
  },
  get sharedConfig() {
    return this.ctrl._config.shared
  },
  get handler() {
    return this.ctrl._handlers[this.key]
  }
}

Engine.prototype.reset = function () {
  const state = this.state
  state._active = state.active = state._blocked = state._force = false
  state._step = [false, false]
  state.intentional = false
  state._movement = [0, 0]
  // @ts-ignore
  state._threshold = this.config.threshold || [0, 0]
  // prettier-ignore
  state._bounds = [[-Infinity, Infinity], [-Infinity, Infinity]]
  state.memo = undefined
  state.direction = [0, 0]
  state.distance = [0, 0]
  state.velocity = [0, 0]
  state.movement = [0, 0]
  state.delta = [0, 0]
  state.timeStamp = 0
} as Engine['reset']

Engine.prototype.start = function (event) {
  const state = this.state
  const config = this.config
  if (!state._active) {
    this.reset()
    state._active = true
    state.target = event.currentTarget!
    state.initial = state.values
    state.lastOffset = config.from ? call(config.from, state) : state.offset
    state.offset = state.lastOffset
  }
} as Engine['start']

Engine.prototype.compute = function (event) {
  const state = this.state
  const config = this.config
  const shared = this.shared

  if (event) {
    state.event = event
    shared.touches = this.ctrl._pointerIds.size || this.ctrl._touchIds.size
    shared.locked = !!document.pointerLockElement
    Object.assign(shared, getEventDetails(event))
    shared.down = shared.pressed = shared.buttons > 0 || shared.touches > 0
  }

  const [_m0, _m1] = state._movement
  const [_t0, _t1] = state._threshold
  let [_s0, _s1] = state._step

  if (_s0 === false) _s0 = Math.abs(_m0) >= _t0 && Math.sign(_m0) * _t0
  if (_s1 === false) _s1 = Math.abs(_m1) >= _t1 && Math.sign(_m1) * _t1

  state.intentional = _s0 !== false || _s1 !== false

  if (!state.intentional) return

  state._step = [_s0, _s1]

  const movement: Vector2 = [0, 0]

  movement[0] = _s0 !== false ? _m0 - _s0 : 0
  movement[1] = _s1 !== false ? _m1 - _s1 : 0

  if (this.intent) this.intent(movement)

  if ((state._active && !state._blocked) || state.active) {
    state.first = state._active && !state.active
    state.last = !state._active && state.active
    state.active = shared[this.ingKey] = state._active

    if (event) {
      const dt = event.timeStamp - state.timeStamp
      state.timeStamp = event.timeStamp

      if (state.first) {
        if ('bounds' in config) state._bounds = call(config.bounds, state)
        state.startTime = state.timeStamp
        if (this.setup) this.setup()
      }

      state.elapsedTime = state.timeStamp - state.startTime

      const previousMovement = state.movement
      state.movement = movement

      const absoluteDelta = state.delta.map(Math.abs) as Vector2

      V.addTo(state.distance, absoluteDelta)
      this.computeOffset()

      if (!state.first && !state.last && dt > 0) {
        state.delta = V.sub(movement, previousMovement)
        state.direction = state.delta.map(Math.sign) as Vector2
        state.velocity = [absoluteDelta[0] / dt, absoluteDelta[1] / dt]
      }
    }
  }

  // @ts-ignore
  const rubberband: Vector2 = state._active ? config.rubberband || [0, 0] : [0, 0]
  state.offset = computeRubberband(state._bounds, state.offset, rubberband)
  this.computeMovement()
} as Engine['compute']

Engine.prototype.emit = function () {
  const state = this.state
  const shared = this.shared
  const config = this.config

  if (!state._active) this.clean()

  if ((state._blocked || !state.intentional) && !state._force && !config.triggerAllEvents) return

  const memo = this.handler({
    ...shared,
    ...state,
    args: this.args
  })

  // Sets memo to the returned value of the handler (unless it's  undefined)
  if (memo !== undefined) state.memo = memo
} as Engine['emit']

Engine.prototype.clean = function () {
  this.eventStore.clean()
  this.timeoutStore.clean()
} as Engine['clean']

function computeRubberband(bounds: [Vector2, Vector2], [Vx, Vy]: Vector2, [Rx, Ry]: Vector2): Vector2 {
  const [[X0, X1], [Y0, Y1]] = bounds
  return [rubberbandIfOutOfBounds(Vx, X0, X1, Rx), rubberbandIfOutOfBounds(Vy, Y0, Y1, Ry)]
}