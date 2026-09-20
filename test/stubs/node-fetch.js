/* Test double for node-fetch.
 *
 * node_helper.js captures `fetch` at require time, so swapping the module
 * export later would not affect it. This stub keeps a stable function
 * identity and delegates to whatever handler the current test installs.
 */
let handler = () => {
  throw new Error("node-fetch stub: no handler installed for this test");
};

function fetchStub(...args) {
  return handler(...args);
}

fetchStub.setHandler = (fn) => {
  handler = fn;
};

fetchStub.reset = () => {
  handler = () => {
    throw new Error("node-fetch stub: no handler installed for this test");
  };
};

module.exports = fetchStub;
