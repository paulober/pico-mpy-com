# Pico MPY Com

This is a simple NPM package for communicating with a Raspberry Pi Pico boards running MicroPython.
It utilizes serial over USB to communicate with the board.

> Note: It's possible to use this package with other boards running MicroPython, but it's not guaranteed to work. In order to do so, you need your own port detection as the built-in one is specific to Raspberry Pi Pico MicroPython firmware (CDC) | Vendor ID = `0x2E8A` and Product ID `0x0005`.

## Installation

> Note: It's required to authenticate with the GitHub package registry in order to install this package. [github/docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)

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

> Note: The ports detected are filtered by `vendorId` and `productId` of the Raspberry Pi Pico board with MicroPython (CDC) firmware.

## Docs (TODO)


## License

The project is licensed under the Apache 2.0 license.
