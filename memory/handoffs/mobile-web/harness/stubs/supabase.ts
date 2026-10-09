// A client that answers every query with nothing, and every auth call with the seeded user.
const auth = {
  getUser: async () => ({ data: { user: { id: 'user-1', email: 'kirby@example.com' } }, error: null }),
  getSession: async () => ({ data: { session: null }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  signOut: async () => ({ error: null }),
};
const empty = { data: [], error: null, count: 0 };
const chain: any = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === 'then') return (res: any, rej: any) => Promise.resolve(empty).then(res, rej);
    if (prop === 'auth') return auth;
    return chain;
  },
  apply() {
    return chain;
  },
});
export const createClient = () => chain;
