export class GrowthBook {
  constructor() {}
  loadFeatures() { return Promise.resolve(); }
  isOn() { return false; }
  getFeatureValue(v, d) { return d; }
  destroy() {}
}
export default {};
