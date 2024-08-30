/**
 * Contains the events that can be emitted by the PicoMpyCom class.
 */
export enum PicoSerialEvents {
  // default port events
  portOpened = "portOpened",
  portClosed = "portClosed",
  portError = "portError",

  // need to be subscribed to by operation executors
  interrupt = "interrupt",

  // queue events
  startOperation = "startOperation",
  relayInput = "relayInput",
  // triggered if relaying input fails
  relayInputError = "relayInputError",
}
