function clone(value) {
  return structuredClone(value);
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matches(value, expected) {
  if (expected && expected.__operator === "lte") {
    return comparable(value) <= comparable(expected.value);
  }
  if (expected && expected.__operator === "in") {
    return expected.values.includes(value);
  }
  return comparable(value) === comparable(expected);
}

function createMemoryDb(initial = {}) {
  let state = clone({
    users: {},
    generation_jobs: {},
    generation_preparations: {},
    credit_events: {},
    redemption_codes: {},
    share_grants: {},
    ...initial,
  });
  let transactionQueue = Promise.resolve();
  const queryCalls = [];

  function collectionFor(targetState, name) {
    const rows = targetState[name];
    if (!rows) throw new Error(`Unknown collection: ${name}`);

    let conditions = {};
    let orderings = [];
    let offset = 0;
    let pageSize = 100;

    const collection = {
      doc(id) {
        return {
          async get() {
            return { data: rows[id] ? clone(rows[id]) : null };
          },
          async set({ data }) {
            rows[id] = { _id: id, ...clone(data) };
            return { stats: { created: 1, updated: 0 } };
          },
          async update({ data }) {
            if (!rows[id]) throw new Error(`Missing document: ${name}/${id}`);
            rows[id] = { ...rows[id], ...clone(data), _id: id };
            return { stats: { updated: 1 } };
          },
          async remove() {
            delete rows[id];
            return { stats: { removed: 1 } };
          },
        };
      },
      where(nextConditions) {
        conditions = { ...conditions, ...nextConditions };
        return collection;
      },
      orderBy(field, direction) {
        orderings.push({ field, direction });
        return collection;
      },
      skip(value) {
        offset = value;
        return collection;
      },
      limit(value) {
        pageSize = Math.min(value, 100);
        return collection;
      },
      async get() {
        queryCalls.push({
          collection: name,
          conditions: clone(conditions),
          orderings: clone(orderings),
          offset,
          pageSize,
        });
        const documents = Object.values(rows)
          .filter((document) => Object.entries(conditions).every(
            ([field, expected]) => matches(document[field], expected),
          ))
          .map(clone);
        documents.sort((left, right) => {
          for (const { field, direction } of orderings) {
            const leftValue = comparable(left[field]);
            const rightValue = comparable(right[field]);
            if (leftValue === rightValue) continue;
            const comparison = leftValue < rightValue ? -1 : 1;
            return direction === "desc" ? -comparison : comparison;
          }
          return 0;
        });
        return { data: documents.slice(offset, offset + pageSize) };
      },
    };
    return collection;
  }

  const db = {
    command: {
      lte(value) {
        return { __operator: "lte", value };
      },
      in(values) {
        return { __operator: "in", values };
      },
    },
    collection(name) {
      return collectionFor(state, name);
    },
    async runTransaction(callback) {
      const run = transactionQueue.then(async () => {
        const transactionState = clone(state);
        const transaction = {
          collection(name) {
            return collectionFor(transactionState, name);
          },
        };
        const result = await callback(transaction);
        state = transactionState;
        return clone(result);
      });
      transactionQueue = run.catch(() => {});
      return run;
    },
    seed(collectionName, document) {
      state[collectionName][document._id] = clone(document);
    },
    rows(collectionName) {
      return state[collectionName];
    },
    queryCalls,
  };

  return db;
}

module.exports = { createMemoryDb };
