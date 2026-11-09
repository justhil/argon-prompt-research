export class Result {
  constructor(isOk, value, errorCode = null) {
    this.isOk = isOk;
    this.value = value;
    this.errorCode = errorCode;
  }

  static ok(value) {
    return new Result(true, value, null);
  }

  static fail(errorCode, detail = '') {
    if (!errorCode) throw new Error('Result.fail requires an errorCode');
    return new Result(false, detail, errorCode);
  }
}
