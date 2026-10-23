export class DefaultAccessConstructor {
  constructor(name: string, options?: ErrorOptions) {
    void name;
    void options;
  }
}

export class PublicConstructor {
  public constructor(_id: string) {}
}

export class PrivateConstructor {
  private constructor(secret: string) {
    void secret;
  }
}

export class ProtectedConstructor {
  protected constructor(secret: string) {
    void secret;
  }
}

export class OverloadedConstructor {
  constructor(value: string);
  constructor(value: number, options?: ErrorOptions);
  constructor(value: string | number, options?: ErrorOptions) {
    void value;
    void options;
  }
}

export class ParameterPropertyConstructor {
  constructor(public readonly code: string, private secret: number, protected label?: string) {
    void this.secret;
    void this.label;
  }
}

export class ConstructorWithoutOptionalParameter {
  constructor(_message: string) {}
}
