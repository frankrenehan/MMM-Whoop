/* Minimal stand-in for MagicMirror's NodeHelper so node_helper.js can be
 * loaded in tests without the full MagicMirror runtime.
 * Mirrors NodeHelper.create(): returns a class whose instances get the
 * module definition assigned onto them.
 */
class NodeHelper {
  sendSocketNotification() {}
}

NodeHelper.create = function (moduleDefinition) {
  return class extends NodeHelper {
    constructor() {
      super();
      Object.assign(this, moduleDefinition);
    }
  };
};

module.exports = NodeHelper;
