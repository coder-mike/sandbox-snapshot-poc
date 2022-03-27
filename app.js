console.log('Starting app')
let counter = 0;
exports.incr = () => {
  console.log(`Incrementing counter from ${counter} to ${counter + 1}`);
  counter++;
  return counter;
}