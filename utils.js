Date.prototype.toISODate = function() {
    var day   = this.getDate();
    var month = this.getMonth() + 1;
    var year  = this.getYear() + 1900;
    if (day   < 10) day   = '0' + day;
    if (month < 10) month = '0' + month;

    return year + '-' + month + '-' + day;
}