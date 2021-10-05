import RpcMap from '../common/RpcMap';

const notImplemented = {
  validate: (_params: unknown) => {
    throw new Error('Not implemented');
  },
  handle: async () => {
    throw new Error('Not implemented');
  },
};

export default function RequestHandler(): (
  ...args: unknown[]
) => Promise<unknown> {
  const handlerMap: {
    [M in keyof RpcMap]: {
      validate: (params: unknown) => RpcMap[M]['params'];
      handle: (...params: RpcMap[M]['params']) => Promise<RpcMap[M]['result']>;
    };
  } = {
    eth_sendTransaction: notImplemented,
    add: {
      validate: (params) => {
        if (!Array.isArray(params)) {
          throw new Error('Expected array');
        }

        if (params.length !== 2) {
          throw new Error('Expected two elements');
        }

        const [a, b] = params;

        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new Error('Expected numbers');
        }

        return [a, b];
      },
      handle: async (a, b) => a + b,
    },
  };

  return async (...args) => {
    if (args.length !== 1) {
      throw new Error('Expected one argument');
    }

    const [request] = args;

    if (typeof request !== 'object' || request === null) {
      throw new Error('Expected an object');
    }

    const requestRecord = request as Record<string, unknown>;

    const { method } = requestRecord;

    if (typeof method !== 'string') {
      throw new Error('Expected method string');
    }

    if (!Object.keys(handlerMap).includes(method)) {
      throw new Error(`Unrecognized method: ${method}`);
    }

    const validMethod = method as keyof typeof handlerMap;

    const validParams = handlerMap[validMethod].validate(requestRecord.params);

    return await handlerMap[validMethod].handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(validParams as any),
    );
  };
}