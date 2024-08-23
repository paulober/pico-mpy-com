# Pico MPY Com

This is a simple NPM package for communicating with a Raspberry Pi Pico (2) board running MicroPython.
It utilizes serial over USB to communicate with the board.

## Installation

> TODO: add github package registry setup instructions

```bash
npm install @paulober/pico-mpy-com
```

## Usage

```typescript
import { PicoMPYCom, PicoSerialEvents, OperationResultType } from '@paulober/pico-mpy-com';

// Get a list of available serial ports
const ports = await PicoMPYCom.getSerialPorts();

// List all ports
for (const port of ports) {
    console.log(`- ${port}`);
}

// Retrieve the singleton instance of the PicoMPYCom class
const serialCom = PicoMpyCom.getInstance();

// Listen for connection events
serialCom.on(PicoSerialEvents.portOpened, () => {
    console.log("\x1b[32mSuccessfully connected to the board.\x1b[0m\n");
});

serialCom.on(PicoSerialEvents.portClosed, () => {
    console.log("\x1b[31mThe board has been disconnected.\x1b[0m");
});

serialCom.on(PicoSerialEvents.portError, error => {
    console.error(`${error}`);
});

// Connect to the first available port
await serialCom.openSerialPort(ports[0]);

// Send a predefined Hello World command to the board
const result = await serialCom.helloWorld();
// Check the result type
if (result.type === OperationResultType.commandResponse) {
    console.log(`Response: ${result.response}`);
} else {
    console.error("An error occurred while sending the command.");
}

// Close the connection to the serial port
// This is important as keeping the port open
// will prevent other applications from using it
await serialCom.closeSerialPort();
```

> Note: The port detcted are filter by the `vendorId` and `productId` of the Raspberry Pi Pico board with MicroPython (CDC) firmware.

## Docs (TODO)


## License

The project is licensed under the Apache 2.0 license.
