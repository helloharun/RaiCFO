import type { DB } from './db.js';

type SeedAccount = [code: string, name: string, type: string, subtype: string, aliases?: string, institution?: string];

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  ['1000', 'Cash on Hand', 'asset', 'cash', 'cash,wallet'],
  ['1010', 'TD Chequing', 'asset', 'bank', 'td,chequing,checking,debit card,debit', 'TD'],
  ['1020', 'TD Savings', 'asset', 'savings', 'savings,td savings', 'TD'],
  ['1030', 'Wealthsimple Cash', 'asset', 'bank', 'wealthsimple cash,ws cash', 'Wealthsimple'],
  ['1100', 'Non-Registered Investments', 'asset', 'investment', 'brokerage,non-registered,investment account'],
  ['1110', 'TFSA', 'asset', 'tfsa', 'tfsa'],
  ['1120', 'RRSP', 'asset', 'rrsp', 'rrsp'],
  ['1130', 'Other Investments', 'asset', 'other_investment', 'crypto,other investment'],
  ['1200', 'Vehicle', 'asset', 'vehicle', 'car,vehicle,truck'],
  ['1210', 'Property', 'asset', 'property', 'house,condo,property,home'],
  ['1220', 'Personal Assets', 'asset', 'personal_asset', 'laptop,furniture,personal asset'],
  ['1300', 'Accounts Receivable', 'asset', 'accounts_receivable', 'receivable,owed to me,ious'],
  ['1900', 'Other Assets', 'asset', 'other_asset'],
  ['2000', 'MBNA Credit Card', 'liability', 'credit_card', 'mbna,mastercard,credit card,credit', 'MBNA'],
  ['2100', 'Line of Credit', 'liability', 'line_of_credit', 'loc,line of credit'],
  ['2200', 'Personal Loan', 'liability', 'personal_loan', 'personal loan,loan'],
  ['2210', 'Auto Loan', 'liability', 'auto_loan', 'car loan,auto loan,vehicle loan'],
  ['2220', 'Student Loan', 'liability', 'student_loan', 'student loan,osap,nslsc'],
  ['2300', 'Mortgage', 'liability', 'mortgage', 'mortgage'],
  ['2400', 'Accounts Payable', 'liability', 'accounts_payable', 'payable,i owe'],
  ['2900', 'Other Liabilities', 'liability', 'other_liability'],
  ['3000', 'Opening Balance Equity', 'equity', 'opening_balance_equity'],
  ['3100', 'Owner Contributions', 'equity', 'owner_contribution'],
  ['3200', 'Owner Withdrawals', 'equity', 'owner_withdrawal'],
  ['3300', 'Accumulated Equity', 'equity', 'accumulated_equity'],
  ['4000', 'Employment Income', 'income', 'employment', 'salary,paycheque,paycheck,payroll,wage,wages,bonus'],
  ['4100', 'Business Income', 'income', 'business', 'business income,sales'],
  ['4200', 'Freelance Income', 'income', 'freelance', 'freelance,contract,client,invoice,consulting'],
  ['4300', 'Interest Income', 'income', 'interest', 'interest earned,interest income'],
  ['4400', 'Dividend Income', 'income', 'dividend', 'dividend,dividends,distribution'],
  ['4500', 'Capital Gains', 'income', 'capital_gains', 'capital gain,capital gains'],
  ['4900', 'Other Income', 'income', 'other_income', 'gift received,cashback,rebate,other income'],
  ['5000', 'Housing', 'expense', 'housing', 'housing,condo fees,property tax,strata'],
  ['5010', 'Rent', 'expense', 'rent', 'rent,landlord'],
  ['5020', 'Mortgage Interest', 'expense', 'mortgage_interest', 'mortgage interest'],
  ['5030', 'Utilities', 'expense', 'utilities', 'hydro,electricity,water bill,gas bill,enbridge,utilities,heating'],
  ['5100', 'Groceries', 'expense', 'groceries', 'groceries,grocery,walmart,costco,loblaws,no frills,sobeys,metro,food basics,freshco,superstore,safeway,save-on,farm boy,t&t,whole foods,longos,zehrs,iga,produce'],
  ['5110', 'Restaurants', 'expense', 'restaurants', 'restaurant,dinner,lunch,breakfast,brunch,cafe,coffee,starbucks,tim hortons,tims,mcdonalds,mcdonald\'s,uber eats,ubereats,doordash,skip the dishes,pizza,sushi,takeout,take-out,bar,pub,a&w,subway,chipotle,burger'],
  ['5200', 'Transportation', 'expense', 'transportation', 'uber,lyft,taxi,parking,toll,407,transportation'],
  ['5210', 'Gas', 'expense', 'gas', 'gas,fuel,gasoline,petro-canada,petro canada,esso,shell,husky,ultramar,pioneer,chevron,fill up'],
  ['5220', 'Public Transit', 'expense', 'public_transit', 'presto,ttc,go train,transit,bus pass,metro pass,compass card,opus,oc transpo'],
  ['5230', 'Vehicle Maintenance', 'expense', 'vehicle_maintenance', 'oil change,car repair,mechanic,tires,car wash,canadian tire auto'],
  ['5240', 'Vehicle Insurance', 'expense', 'vehicle_insurance', 'car insurance,auto insurance,vehicle insurance'],
  ['5300', 'Health', 'expense', 'health', 'pharmacy,shoppers drug mart,rexall,dentist,doctor,physio,massage,prescription,optometrist,glasses,health,gym,goodlife'],
  ['5310', 'Insurance', 'expense', 'insurance', 'insurance,life insurance,tenant insurance,home insurance'],
  ['5400', 'Phone', 'expense', 'phone', 'phone bill,cell phone,mobile,rogers wireless,fido,koodo,freedom mobile,public mobile,virgin mobile,chatr'],
  ['5410', 'Internet', 'expense', 'internet', 'internet,wifi,bell internet,rogers internet,teksavvy'],
  ['5500', 'Entertainment', 'expense', 'entertainment', 'movie,movies,cineplex,concert,tickets,game,games,steam,playstation,xbox,nintendo,bowling,entertainment'],
  ['5510', 'Shopping', 'expense', 'shopping', 'amazon,best buy,ikea,canadian tire,home depot,dollarama,winners,shopping,staples'],
  ['5520', 'Clothing', 'expense', 'clothing', 'clothes,clothing,shoes,uniqlo,h&m,zara,old navy,gap,lululemon,sport chek,jacket'],
  ['5600', 'Education', 'expense', 'education', 'tuition,books,course,udemy,coursera,education,textbook'],
  ['5610', 'Professional Expenses', 'expense', 'professional', 'professional dues,membership,license,cpa dues,professional'],
  ['5700', 'Bank Fees', 'expense', 'bank_fees', 'bank fee,bank fees,service charge,monthly fee,nsf,overdraft fee,atm fee'],
  ['5710', 'Interest Expense', 'expense', 'interest_expense', 'interest charge,interest expense,loan interest'],
  ['5720', 'Taxes', 'expense', 'taxes', 'income tax,cra,tax payment,taxes'],
  ['5800', 'Subscriptions', 'expense', 'subscriptions', 'netflix,spotify,disney+,disney plus,crave,apple music,icloud,youtube premium,prime membership,chatgpt,subscription,patreon,adobe'],
  ['5810', 'Travel', 'expense', 'travel', 'flight,hotel,airbnb,air canada,westjet,porter,flair,expedia,travel,vacation,via rail'],
  ['5820', 'Gifts', 'expense', 'gifts', 'gift,gifts,present,donation,charity'],
  ['5900', 'Other Expenses', 'expense', 'other_expense', 'misc,miscellaneous,other expense'],
];

export const DEFAULT_FX: Array<[string, number]> = [
  ['CAD', 1],
  ['USD', 1.37],
  ['EUR', 1.49],
  ['GBP', 1.74],
  ['JPY', 0.0092],
  ['AUD', 0.91],
  ['INR', 0.0164],
  ['CNY', 0.19],
  ['MXN', 0.074],
];

const SYSTEM_CODES = new Set(['3000', '3100', '3200', '3300', '4500']);

export async function seedIfEmpty(db: DB): Promise<void> {
  const hasUser = await db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (hasUser.n === 0) await db.prepare("INSERT INTO users (id, name, base_currency) VALUES (1, 'Me', 'CAD')").run();

  const n = (await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = 1').get() as { n: number }).n;
  if (n === 0) {
    const ins = db.prepare(
      'INSERT INTO accounts (user_id, code, name, type, subtype, aliases, institution, sort_order, is_system) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    await db.transaction(async () => {
      for (const [i, [code, name, type, subtype, aliases, institution]] of DEFAULT_ACCOUNTS.entries())
        await ins.run(code, name, type, subtype, aliases ?? null, institution ?? null, i, SYSTEM_CODES.has(code) ? 1 : 0);
    })();
  }

  const fx = (await db.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number }).n;
  if (fx === 0) {
    const ins = db.prepare("INSERT INTO fx_rates (currency, date, rate) VALUES (?, '1970-01-01', ?)");
    for (const [c, r] of DEFAULT_FX) await ins.run(c, r);
  }
}
