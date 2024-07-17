import getVetoPattern from "./getVetoPattern";

describe('veto-pattern', () => {
  it('should generate correct pattern for pool size 7 and bestOf 3', () => {
    const expectedPattern = [
      'Ban', 'Ban', 'Pick', 'Pick', 'Ban', 'Ban'
    ];
    const pattern = getVetoPattern(new Array(7), 3);
    expect(pattern).toEqual(expectedPattern);
  });

  it('should generate correct pattern for pool size 7 and bestOf 5', () => {
    const expectedPattern = [
      'Ban', 'Ban', 'Pick', 'Pick',
      'Pick', 'Pick'
    ];
    const pattern = getVetoPattern(new Array(7), 5);
    expect(pattern).toEqual(expectedPattern);
  });

  it('should generate correct pattern for pool size 24 and bestOf 3', () => {
    const expectedPattern = [
      'Ban', 'Ban', 'Pick', 'Pick',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban'
    ];
    const pattern = getVetoPattern(new Array(24), 3);
    expect(pattern).toEqual(expectedPattern);
  });

  it('should generate correct pattern for pool size 24 and bestOf 5', () => {
    const expectedPattern = [
      'Ban', 'Ban', 'Pick', 'Pick',
      'Ban', 'Ban', 'Pick', 'Pick',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban', 'Ban',
      'Ban', 'Ban', 'Ban'
    ];
    const pattern = getVetoPattern(new Array(24), 5);
    expect(pattern).toEqual(expectedPattern);
  });
});
