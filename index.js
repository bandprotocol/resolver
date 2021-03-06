const delay = require('delay')
const Koa = require('koa')
const Sequelize = require('sequelize')
const Op = Sequelize.Op
const exec = require('child-process-promise').exec

const Web3Interface = require('./app/web3')
const config = require('./config')

const ipc = config.gethConnection

const app = new Koa()
let web3 = null

let waitTime = 0

const addressToID = {}

async function onNewTask(address, onChainID, resolveTime, blockNumber) {
  console.log('NEW TASK', address, onChainID, resolveTime, blockNumber)
  if (addressToID[address] === undefined) {
    console.log(`This contract address ${address} doesn't appear in database`)
  }

  const task = await Task.findOne({
    where: {
      contractID: addressToID[address],
      onChainID: onChainID,
    },
  })

  if (!task) {
    await Task.create({
      contractID: addressToID[address],
      onChainID,
      finishedAt: resolveTime,
      status: 'WAITING',
    })
  }

  await Setting.update(
    {
      value: blockNumber,
    },
    {
      where: {
        key: {
          [Op.like]: 'lastBlock',
        },
      },
    },
  )
}

async function onTaskNotPassed(address, onChainID) {
  console.log('NOT RESOLVE', address, onChainID)
  const task = await Task.findOne({
    where: {
      contractID: addressToID[address],
      onChainID: onChainID,
    },
  })

  if (!task) {
    await Task.create({
      contractID: addressToID[address],
      onChainID,
      finishedAt: new Date(),
      status: 'NOT_PASSED',
    })
    return
  }

  if (task.status === 'RESOLVED') return

  await Task.update(
    {
      status: 'NOT_PASSED',
    },
    {
      where: {
        contractID: addressToID[address],
        onChainID: onChainID,
      },
    },
  )
}

async function onTaskResolved(address, onChainID, blockNumber) {
  console.log('RESOLVED', address, onChainID, blockNumber)
  const task = await Task.findOne({
    where: {
      contractID: addressToID[address],
      onChainID: onChainID,
    },
  })

  if (!task) {
    await Task.create({
      contractID: addressToID[address],
      onChainID,
      finishedAt: new Date(),
      status: 'RESOLVED',
    })
    return
  }
  await Task.update(
    {
      status: 'RESOLVED',
    },
    {
      where: {
        contractID: addressToID[address],
        onChainID: onChainID,
      },
    },
  )

  await Setting.update(
    {
      value: blockNumber,
    },
    {
      where: {
        key: {
          [Op.like]: 'lastBlock',
        },
      },
    },
  )
}

async function onSendResolve(address, onChainID) {
  console.log(
    'Send resolve transaction to',
    address,
    'with onChainID',
    onChainID,
  )

  await Transaction.create({
    onChainID,
    contractID: addressToID[address],
  })
}

async function onEventLoop() {
  // Send resolve after waiting
  const now = new Date()
  const needResolvedTasks = await Task.findAll({
    include: [
      {
        model: Contract,
      },
    ],
    where: {
      status: {
        [Op.like]: 'WAITING',
      },
      finishedAt: {
        [Op.lt]: now,
      },
    },
  })

  for (const task of needResolvedTasks) {
    web3.sendResolveTransaction(task.contract.address, task.onChainID)
    const now = new Date().getTime()
    const nextTxSent = new Date(now + waitTime)
    task.update({ status: 'RESOLVING', nextTxSent })
  }

  // Resend resolve in some bad case happen
  const needResendTasks = await Task.findAll({
    include: [
      {
        model: Contract,
      },
    ],
    where: {
      status: {
        [Op.like]: 'RESOLVING',
      },
      nextTxSent: {
        [Op.lt]: now,
      },
    },
  })
  for (const task of needResendTasks) {
    web3.sendResolveTransaction(task.contract.address, task.onChainID, nonce)
    const now = new Date().getTime()
    const nextTxSent = new Date(now + waitTime)
    task.update({ nextTxSent })
  }
}

// TODO: Initialize database here
const sequelize = new Sequelize('resolver', 'root', config.dbPassword, {
  dialect: 'mysql',
  host: 'wiki.chjypicevp5k.ap-southeast-1.rds.amazonaws.com',
  logging: false,
})

const Contract = sequelize.define('contract', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  address: {
    allowNull: false,
    type: Sequelize.STRING,
  },
  contractType: {
    allowNull: false,
    type: Sequelize.STRING,
  },
  subscribe: Sequelize.BOOLEAN,
})

const Task = sequelize.define(
  'task',
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    onChainID: {
      allowNull: false,
      type: Sequelize.INTEGER,
    },
    finishedAt: Sequelize.DATE,
    status: Sequelize.STRING,
    nextTxSent: Sequelize.DATE,
  },
  {
    indexes: [
      {
        unique: true,
        fields: ['contractID', 'onChainID'],
      },
    ],
  },
)

Task.belongsTo(Contract, { foreignKey: 'contractID' })

const Transaction = sequelize.define('transaction', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  onChainID: {
    allowNull: false,
    type: Sequelize.INTEGER,
  },
})

Transaction.belongsTo(Contract, { foreignKey: 'contractID' })

const Setting = sequelize.define('setting', {
  key: Sequelize.STRING,
  value: Sequelize.INTEGER,
})

app.use(async ctx => {
  const now = new Date()
  const inOneDay = {
    [Op.between]: [new Date(now.getTime() - 86400000), now],
  }

  const allTaskCount = await Task.count({
    where: {
      finishedAt: inOneDay,
    },
  })

  const resolvedTaskCount = await Task.count({
    where: {
      finishedAt: inOneDay,
      status: {
        [Op.like]: 'RESOLVED',
      },
    },
  })

  const notPassedTaskCount = await Task.count({
    where: {
      finishedAt: inOneDay,
      status: {
        [Op.like]: 'NOT_PASSED',
      },
    },
  })

  const transactionSentCount = await Transaction.count({
    where: {
      createdAt: inOneDay,
    },
  })

  const pendingTransactionCount = (await exec(
    `geth attach --datadir ${ipc} --exec 'eth.pendingTransactions.length'`,
  )).stdout
  ctx.body = `
  All task need to resolve today ${resolvedTaskCount}/${allTaskCount -
    notPassedTaskCount} (Not passed proposal ${notPassedTaskCount})
  Transaction sent ${transactionSentCount}
  Pending transaction ${pendingTransactionCount}`
})

// TODO: Initialize add/remove address route here
;(async () => {
  const contractList = await Contract.findAll()
  const contracts = {}
  contractList.forEach(contract => {
    addressToID[contract.address] = contract.id
    contracts[contract.address] = contract.contractType === 'TCR'
  })

  const lastBlock = (await Setting.findOne({
    where: {
      key: {
        [Op.like]: 'lastBlock',
      },
    },
  })).value

  const lookBehind = (await Setting.findOne({
    where: {
      key: {
        [Op.like]: 'lookBehind',
      },
    },
  })).value

  waitTime = (await Setting.findOne({
    where: {
      key: {
        [Op.like]: 'waitTime',
      },
    },
  })).value

  // // Initialize Web3Interface
  web3 = new Web3Interface(
    contracts,
    lastBlock,
    lookBehind,
    onNewTask,
    onTaskResolved,
    onTaskNotPassed,
    onSendResolve,
  )

  // Run the event loop every 1 second
  ;(async () => {
    while (true) {
      await delay(1000)
      await onEventLoop()
    }
  })()

  app.listen(9999)
})()
