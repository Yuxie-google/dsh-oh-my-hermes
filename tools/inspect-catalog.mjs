// Simulates what dsh asks a freshly booted plugin: "which models does hermes-remote have?"
import { HermesAdapter, configView } from '../lib/index.js'

const adapter = new HermesAdapter(
  { llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} }, logger: () => {} },
  {}, // no bundle patch at all: everything comes from the saved config file
)

const view = configView(adapter)
console.log('config file :', view.file, view.exists ? '(exists)' : '(missing)')
console.log('hosts       :', view.hosts.map((host) => host.id).join(', '))
for (const provider of adapter.hosts.map((host) => host.id)) {
  const models = await adapter.listModels(provider)
  console.log(`listModels(${provider}) -> ${models.length}`)
  for (const model of models) console.log(`   - ${model.id}  "${model.name}"  hers=${JSON.stringify(adapter.byId.get(provider).models.find((m) => m.id === model.id)?.hermesModel)}`)
}
