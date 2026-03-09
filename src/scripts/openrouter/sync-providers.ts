import { syncAndStoreProviders } from '@/lib/providers/openrouter/sync-providers';

async function run() {
  const result = await syncAndStoreProviders();
  console.log(
    `Successfully synced ${result.total_providers} providers with ${result.total_models} total models`
  );
}

// Run the script if called directly
if (require.main === module) {
  run()
    .then(() => {
      console.log('Sync completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Sync failed:', error);
      process.exit(1);
    });
}

export { run };
