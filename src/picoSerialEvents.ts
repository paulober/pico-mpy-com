export enum PicoSerialEvents {
  portOpened = "portOpened",
  portClosed = "portClosed",
  portError = "portError",

  // need to be subscribed to by operation executors
  interrupt = "interrupt",

  startOperation = "startOperation",
  relayInput = "relayInput",
  // triggered if relaying input fails
  relayInputError = "relayInputError",
}
