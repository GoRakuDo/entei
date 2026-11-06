/**
 * `bun:test` type declarations for the test suite.
 * ---------------------------------------------------------------------------
 * Bun ships its own test API, but the published `@types/bun` (1.4.4) types a
 * strict subset of it: `vi.hoisted`, `vi.stubGlobal`, `vi.unstubAllGlobals`,
 * `vi.mocked`, `vi.waitFor`, `vi.resetModules` and
 * `vi.advanceTimersByTimeAsync` exist at runtime and are used throughout this
 * suite, yet they are missing from the declaration. Bun also types `fetch`
 * with a non-standard `preconnect` member, which makes `vi.fn<typeof fetch>`
 * unusable.
 *
 * Rather than pull in `@types/bun` (and then be unable to extend the
 * non-augmentable `vi` object type), the suite declares the surface it
 * actually uses. Matcher *names* and mock APIs stay checked; matcher
 * *arguments* are intentionally permissive so the suite does not have to
 * mirror every overload.
 *
 * Keep this file free of top-level import/export statements: it must stay a
 * script so `declare module 'bun:test'` is an ambient declaration rather than
 * an augmentation of a module nobody declares.
 */

declare module 'bun:test' {
  type AnyFn = (...args: any[]) => any;

  type TLMatchers<E, R> = import('@testing-library/jest-dom/matchers').TestingLibraryMatchers<
    E,
    R
  >;

  interface Mock<T extends AnyFn = AnyFn> {
    (...args: Parameters<T>): ReturnType<T>;
    // Bun's mocks are constructible (`vi.fn(class {})`), and the suite leans
    // on that when it swaps a `vi.fn()` in for a DOM constructor
    // (`global.ResizeObserver = vi.fn(function () { ... })`).
    new (...args: any[]): any;
    mock: {
      calls: Parameters<T>[];
      results: { type: 'return' | 'throw' | 'incomplete'; value: any }[];
      instances: any[];
      contexts: any[];
      lastCall: Parameters<T> | undefined;
    };
    mockClear(): Mock<T>;
    mockReset(): Mock<T>;
    mockRestore(): void;
    mockImplementation(fn: AnyFn): Mock<T>;
    mockImplementationOnce(fn: AnyFn): Mock<T>;
    mockReturnValue(value: ReturnType<T>): Mock<T>;
    mockReturnValueOnce(value: ReturnType<T>): Mock<T>;
    mockResolvedValue(value: Awaited<ReturnType<T>>): Mock<T>;
    mockResolvedValueOnce(value: Awaited<ReturnType<T>>): Mock<T>;
    mockRejectedValue(value: any): Mock<T>;
    mockRejectedValueOnce(value: any): Mock<T>;
    mockName(name: string): Mock<T>;
    getMockName(): string;
  }

  interface Matchers<T = any> extends TLMatchers<ReturnType<Expect['stringContaining']>, T> {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toStrictEqual(expected: any): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeNaN(): void;
    toBeInstanceOf(expected: any): void;
    toBeGreaterThan(expected: number | bigint): void;
    toBeGreaterThanOrEqual(expected: number | bigint): void;
    toBeLessThan(expected: number | bigint): void;
    toBeLessThanOrEqual(expected: number | bigint): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toContain(expected: any): void;
    toContainEqual(expected: any): void;
    toHaveLength(expected: number): void;
    toHaveProperty(keyPath: string | string[], value?: any): void;
    toMatch(expected: string | RegExp): void;
    toMatchObject(expected: object): void;
    toThrow(expected?: any): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(count: number): void;
    toHaveBeenCalledOnce(): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveBeenLastCalledWith(...args: any[]): void;
    toHaveBeenNthCalledWith(nth: number, ...args: any[]): void;
    toHaveReturned(): void;
    toHaveReturnedTimes(count: number): void;
    toHaveReturnedWith(value: any): void;
    toHaveLastReturnedWith(value: any): void;
    toMatchSnapshot(hint?: string): void;
    toMatchInlineSnapshot(snapshot?: string): void;
    not: Matchers<T>;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<Awaited<T>>;
  }

  interface AsymmetricMatchers {
    any(ctor: any): any;
    anything(): any;
    arrayContaining(values: readonly any[]): any;
    objectContaining(values: object): any;
    stringContaining(value: string): any;
    stringMatching(value: string | RegExp): any;
  }

  interface Expect extends AsymmetricMatchers {
    <T = any>(actual: T, message?: string): Matchers<T>;
    extend(matchers: Record<string, AnyFn>): void;
    soft<T = any>(actual: T): Matchers<T>;
    assertions(count: number): void;
    hasAssertions(): void;
    unreachable(message?: string): never;
  }

  interface Each {
    /** Row-per-case table: `it.each([[1, 'a']])('…', (n, s) => …)`. */
    <const T extends readonly any[]>(
      table: readonly T[],
    ): (label: string, fn: (...args: [...T]) => any) => void;
    /** Flat list: `it.each(['a', 'b'])('…', (value) => …)`. */
    <T>(table: readonly T[]): (label: string, fn: (value: T) => any) => void;
  }

  interface TestFn {
    (label: string, fn: () => void | Promise<void>, timeout?: number): void;
    only: TestFn;
    skip: TestFn;
    todo: (label?: string) => void;
    concurrent: TestFn;
    serial: TestFn;
    if(condition: boolean): TestFn;
    skipIf(condition: boolean): TestFn;
    each: Each;
  }

  interface DescribeFn {
    (label: string, fn: () => void): void;
    only: DescribeFn;
    skip: DescribeFn;
    todo: (label?: string) => void;
    each: Each;
    if(condition: boolean): DescribeFn;
    skipIf(condition: boolean): DescribeFn;
  }

  interface Vi {
    fn<T extends AnyFn = AnyFn>(impl?: T): Mock<T>;
    spyOn<T extends object, K extends keyof T>(
      obj: T,
      method: K,
    ): Mock<Extract<T[K], AnyFn>>;
    spyOn<T extends object, K extends keyof T>(
      obj: T,
      method: K,
      accessType: 'get' | 'set',
    ): Mock<AnyFn>;
    hoisted<T>(fn: () => T): T;
    mocked<T>(value: T): Mock<Extract<T, AnyFn>>;
    mock(specifier: string, factory?: () => any): void;
    unmock(specifier: string): void;
    doMock(specifier: string, factory?: () => any): void;
    resetModules(): void;
    stubGlobal(name: string, value: unknown): void;
    unstubAllGlobals(): void;
    restoreAllMocks(): void;
    clearAllMocks(): void;
    resetAllMocks(): void;
    useFakeTimers(options?: any): void;
    useRealTimers(): void;
    advanceTimersByTime(ms: number): void;
    advanceTimersByTimeAsync(ms: number): Promise<void>;
    advanceTimersToNextTimer(): void;
    runAllTimers(): void;
    runAllTicks(): void;
    runOnlyPendingTimers(): void;
    getTimerCount(): number;
    clearAllTimers(): void;
    isFakeTimers(): boolean;
    setSystemTime(now?: number | Date): void;
    waitFor<T>(callback: () => T | Promise<T>, options?: any): Promise<T>;
  }

  export const describe: DescribeFn;
  export const it: TestFn;
  export const test: TestFn;
  export const expect: Expect;
  export const vi: Vi;
  export const jest: Vi;
  export const beforeEach: (fn: () => void | Promise<void>) => void;
  export const afterEach: (fn: () => void | Promise<void>) => void;
  export const beforeAll: (fn: () => void | Promise<void>) => void;
  export const afterAll: (fn: () => void | Promise<void>) => void;
  export const mock: {
    module: (specifier: string, factory: () => any) => void;
    restore: () => void;
  };
  export const setSystemTime: (now?: number | Date) => void;
  export const setDefaultTimeout: (ms: number) => void;
}
