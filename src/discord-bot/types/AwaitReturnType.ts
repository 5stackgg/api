type Awaited<T> = T extends PromiseLike<infer U> ? U : T;
export type ReturnTypeAfterAwait<T extends (...args: any) => any> = Awaited<
  ReturnType<T>
>;
