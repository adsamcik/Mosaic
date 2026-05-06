export interface MockWakeLock {
  install(): void;
  uninstall(): void;
  /** Manually trigger a browser revoke event. */
  emitRevoke(): void;
  /** Inspect: how many times was request('screen') called? */
  readonly requestCount: number;
  /** Inspect: how many active sentinels? */
  readonly activeCount: number;
}

class MockWakeLockSentinel extends EventTarget implements WakeLockSentinel {
  public onrelease: WakeLockSentinel['onrelease'] = null;
  public readonly type: WakeLockType = 'screen';
  private isReleased = false;

  public constructor(private readonly onReleased: (sentinel: MockWakeLockSentinel) => void) {
    super();
  }

  public get released(): boolean {
    return this.isReleased;
  }

  public async release(): Promise<void> {
    this.markReleased();
  }

  public emitRevoke(): void {
    this.markReleased();
  }

  private markReleased(): void {
    if (this.isReleased) {
      return;
    }

    this.isReleased = true;
    this.onReleased(this);

    const event = new Event('release');
    this.dispatchEvent(event);
    this.onrelease?.call(this, event);
  }
}

class InMemoryWakeLockMock implements MockWakeLock {
  private readonly sentinels = new Set<MockWakeLockSentinel>();
  private readonly wakeLock: WakeLock;
  private previousDescriptor: PropertyDescriptor | undefined;
  private requests = 0;

  public constructor() {
    this.wakeLock = {
      request: async (type?: WakeLockType): Promise<WakeLockSentinel> => {
        if (type !== undefined && type !== 'screen') {
          throw new TypeError('Only screen wake locks are supported by the mock');
        }

        this.requests += 1;
        const sentinel = new MockWakeLockSentinel((releasedSentinel) => {
          this.sentinels.delete(releasedSentinel);
        });
        this.sentinels.add(sentinel);
        return sentinel;
      },
    };
  }

  public get requestCount(): number {
    return this.requests;
  }

  public get activeCount(): number {
    return this.sentinels.size;
  }

  public install(): void {
    this.previousDescriptor = Object.getOwnPropertyDescriptor(navigator, 'wakeLock');
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: this.wakeLock,
    });
  }

  public uninstall(): void {
    this.sentinels.clear();

    if (this.previousDescriptor) {
      Object.defineProperty(navigator, 'wakeLock', this.previousDescriptor);
      return;
    }

    Reflect.deleteProperty(navigator, 'wakeLock');
  }

  public emitRevoke(): void {
    const sentinel = this.sentinels.values().next().value;
    sentinel?.emitRevoke();
  }
}

/** Create and return an in-memory Screen Wake Lock mock. */
export function createWakeLockMock(): MockWakeLock {
  return new InMemoryWakeLockMock();
}
