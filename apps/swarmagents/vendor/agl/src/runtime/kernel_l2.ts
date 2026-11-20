import { ASTNode } from '../parser.ts';
import { AGLValue, ExecutionContext } from './context.ts';
import { Evaluator } from './evaluator.ts';

export interface SwarmTaskResult {
  agentId: string;
  stage: string;
  output: AGLValue;
  timestamp: number;
}

export class Level2Engine {
  constructor(private evaluator: Evaluator) {}

  /**
   * (lvl:2:pipeline step1 step2 step3 ...)
   * Pipes output of each step as $in into the next step
   */
  public async executePipeline(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue> {
    let currentInput: AGLValue = null;
    if (node.args) {
      for (const step of node.args) {
        if (currentInput !== null) {
          ctx.set('$in', currentInput);
        }
        currentInput = await this.evaluator.evaluate(step, ctx);
      }
    }
    return currentInput;
  }

  /**
   * (lvl:2:parallel branch1 branch2 branch3 ...)
   * Executes multiple expressions concurrently in isolated cloned sub-contexts
   * Returns list of results: [res1, res2, res3]
   */
  public async executeParallel(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue[]> {
    if (!node.args || node.args.length === 0) return [];
    
    const branchPromises = node.args.map(async (branch, idx) => {
      const childCtx = ctx.clone();
      childCtx.set('$branch_id', idx);
      return await this.evaluator.evaluate(branch, childCtx);
    });

    return await Promise.all(branchPromises);
  }

  /**
   * (lvl:2:fan_out collection worker_fn)
   * Maps an AGL list concurrently across a worker function
   */
  public async executeFanOut(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue[]> {
    if (!node.args || node.args.length < 2) throw new Error('fan_out requires collection and worker expression');
    
    const rawColl = await this.evaluator.evaluate(node.args[0], ctx);
    const workerNode = node.args[1];
    const items = Array.isArray(rawColl) ? rawColl : [];

    const tasks = items.map(async (item, idx) => {
      const childCtx = ctx.clone();
      childCtx.set('$item', item);
      childCtx.set('$index', idx);
      return await this.evaluator.evaluate(workerNode, childCtx);
    });

    return await Promise.all(tasks);
  }

  /**
   * (lvl:2:swarm_consensus (agents_list) proposal_expr quorum_ratio)
   * Simulates decentralized multi-agent voting over proposal_expr
   */
  public async executeSwarmConsensus(node: ASTNode, ctx: ExecutionContext): Promise<Record<string, any>> {
    if (!node.args || node.args.length < 3) throw new Error('swarm_consensus requires agents, proposal, and quorum');
    
    const agents = (await this.evaluator.evaluate(node.args[0], ctx)) as string[];
    const proposalNode = node.args[1];
    const quorumTarget = Number(await this.evaluator.evaluate(node.args[2], ctx) || 0.66);

    const votes: Record<string, boolean> = {};
    let affirmative = 0;

    const agentList = Array.isArray(agents) ? agents : ['agent_0', 'agent_1', 'agent_2'];

    for (const agentId of agentList) {
      const agentCtx = ctx.clone();
      agentCtx.set('$agent_id', agentId);
      const evalVote = Boolean(await this.evaluator.evaluate(proposalNode, agentCtx));
      votes[agentId] = evalVote;
      if (evalVote) affirmative++;
    }

    const ratio = agentList.length > 0 ? affirmative / agentList.length : 0;
    const passed = ratio >= quorumTarget;

    return {
      consensus_passed: passed,
      quorum_achieved: ratio,
      quorum_required: quorumTarget,
      total_agents: agentList.length,
      votes
    };
  }
}
