import { GraphQLTypes, InputType } from "../../../generated/zeus";

type FieldsSelector<T extends keyof GraphQLTypes> = {
  [K in keyof GraphQLTypes[T]]: boolean;
};

export type HasuraEventData<T extends keyof GraphQLTypes> = {
  op: "INSERT" | "UPDATE" | "DELETE";
  old: InputType<GraphQLTypes[T], FieldsSelector<T>>;
  new: InputType<GraphQLTypes[T], FieldsSelector<T>>;
};
