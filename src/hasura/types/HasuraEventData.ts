export type HasuraEventData<T> = {
  op: "INSERT" | "UPDATE" | "DELETE";
  old: T;
  new: T;
};
