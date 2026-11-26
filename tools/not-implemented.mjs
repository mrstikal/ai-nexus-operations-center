const [capability, ownerStage] = process.argv.slice(2);

if (!capability || !ownerStage) {
  console.error('Usage: node tools/not-implemented.mjs <capability> <owner stage>');
  process.exit(1);
}

console.error(
  `${capability} is a registered command entry point and is implemented in ${ownerStage}. ` +
    'This build fails closed instead of pretending that the command succeeded.',
);
process.exit(1);
