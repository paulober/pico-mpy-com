interface IQueue<T> {
  enqueue(item: T): void;
  dequeue(): T | undefined;
  size(): number;
  isEmpty(): boolean;
}

/**
 * A simple queue implementation.
 */
export class Queue<T> implements IQueue<T> {
  private items: T[] = [];

  public enqueue(item: T): void {
    this.items.push(item);
  }

  public dequeue(): T | undefined {
    return this.items.shift();
  }

  public size(): number {
    return this.items.length;
  }

  public isEmpty(): boolean {
    return this.size() === 0;
  }
}
