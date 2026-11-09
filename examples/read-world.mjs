import { FrontierClient } from '../agent-client.mjs';

const client = FrontierClient.fromEnv();
const snapshot = await client.world();
const me = snapshot.world.agents.find(agent => agent.id === client.agentId);
console.log({ agent: me.name, demoCredits: me.balance / 1000, revision: snapshot.revision });
// Stop here. A model, strategy, paid service or write requires your own explicit code.
