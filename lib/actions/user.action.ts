'use server';
import { cookies } from "next/headers"
import { createSessionClient } from "../server/appwrite"
import { createAdminClient } from "../server/appwrite"
import { ID, Query } from "node-appwrite"
import { encryptId, extractCustomerIdFromUrl,  } from "../utils"
import { CountryCode, ProcessorTokenCreateRequest, ProcessorTokenCreateRequestProcessorEnum, Products } from "plaid";
import { plaidClient } from "@/lib/plaid";
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";


const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

const parseStringify = (data: any) => JSON.parse(JSON.stringify(data));

export const getUserInfo = async ({ userId }: getUserInfoProps) => {
  try {
    const { database } = await createAdminClient();
    const user = await database.listDocuments(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      [Query.equal('userId', [userId])]
    );

    if (!user || !user.documents || user.documents.length === 0) {
      throw new Error("User not found.");
    }

    return parseStringify(user.documents[0]);
  } catch (error) {
    console.error("Error fetching user info:", error);
    throw new Error("Failed to fetch user information.");
  }
};

export const signIn = async ({ email, password }: signInProps) => {
  try {
    console.log("Starting sign-in...");
    const { account } = await createAdminClient();

    // Create session and log it
    const session = await account.createEmailPasswordSession(email, password);
    console.log("Session created:", session);

    // Validate session data
    if (!session || !session.userId || !session.secret) {
      throw new Error("Invalid session data. Check credentials.");
    }

    // Set cookies (temporary for easier debugging, secure: false for testing)
    const cookiesObj = await cookies();
    cookiesObj.set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: false,  // Change to `true` when deploying in production
    });

    // Fetch user info
    const user = await getUserInfo({ userId: session.userId });
    console.log("User info fetched:", user);

    // Ensure user data is valid
    if (!user) {
      throw new Error("Failed to retrieve user information.");
    }

    return parseStringify(user);
  } catch (error) {
    console.error("Error during sign-in:", error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    throw new Error("Sign-in failed. Please check your credentials.");
  }
};

export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;
  
  let newUserAccount;

  try {
    const { account, database } = await createAdminClient();

    newUserAccount = await account.create(
      ID.unique(), 
      email, 
      password, 
      `${firstName} ${lastName}`
    );

    if(!newUserAccount) throw new Error('Error creating user')

    const dwollaCustomerUrl = await createDwollaCustomer({
      ...userData,
      type: 'personal'
    })

    if(!dwollaCustomerUrl) throw new Error('Error creating Dwolla customer')

    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

    const newUser = await database.createDocument(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      ID.unique(),
      {
        ...userData,
        userId: newUserAccount.$id,
        dwollaCustomerId,
        dwollaCustomerUrl,
        password,
      }
    )

    const session = await account.createEmailPasswordSession(email, password);
    console.log("Session created:", session);

    const cookiesObj = await cookies(); // wait for the promise to resolve
    cookiesObj.set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });
    console.log("Cookies set:", cookiesObj.get("appwrite-session"));
    console.log("Session created:", session);
    return parseStringify(newUser);
  } catch (error) {
    console.error('Error', error);
  }
}

// ... your initilization functions

export async function getLoggedInUser() {
    try {
      const { account } = await createSessionClient();
    const result = await account.get();

    const user = await getUserInfo({ userId: result.$id})

    return parseStringify(user);
    } catch (error) {
      console.log(error)
      return null;
    }
    
  }

  export const logoutAccount= async () => {
    try{
      const{account} = await createSessionClient();

      (await cookies()).delete('appwrite-session'); 

      await account.deleteSession('current');
    }catch(error){
      return null;
    }
  }

  export const createLinkToken = async (user: User) => {
    try {
      const tokenParams = {
        user: {
          client_user_id: user.$id
        },
        client_name: `${user.firstName} ${user.lastName}`,
        products: ['auth', 'transactions'] as Products[], // Include transactions
        language: 'en',
        country_codes: ['US'] as CountryCode[],
      };
  
      const response = await plaidClient.linkTokenCreate(tokenParams);
  
      return parseStringify({ linkToken: response.data.link_token });
    } catch (error) {
      console.log(error);
    }
  };
  

  export const createBankAccount = async ({
    userId,
    bankId,
    accountId,
    accessToken,
    fundingSourceUrl,
    sharableId,
  }: createBankAccountProps) => {
    try{
      const {database} = await createAdminClient();

      const bankAccount = await database.createDocument(
        DATABASE_ID!,
        BANK_COLLECTION_ID!,
        ID.unique(),
        {
          userId,
          bankId,
          accountId,
          accessToken,
          fundingSourceUrl,
          sharableId,
          
        }
      )

      return parseStringify(bankAccount);
    }catch(error){

    }
  }

  export const exchangePublicToken = async ({
    publicToken,
    user,
  }: exchangePublicTokenProps) => {
    try {
      const response = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });
  
      const accessToken = response.data.access_token;
      const itemId = response.data.item_id;
  
      const accountsResponse = await plaidClient.accountsGet({
        access_token: accessToken,
      });
  
      const accountData = accountsResponse.data.accounts[0];
  
      const request: ProcessorTokenCreateRequest = {
        access_token: accessToken,
        account_id: accountData.account_id,
        processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
      };
  
      const processorTokenResponse = await plaidClient.processorTokenCreate(request);
      const processorToken = processorTokenResponse.data.processor_token;
  
      const fundingSourceUrl = await addFundingSource({
        dwollaCustomerId: user.dwollaCustomerId,
        processorToken,
        bankName: accountData.name,
      });
  
      if (!fundingSourceUrl) throw new Error("Funding source URL creation failed");
  
      await createBankAccount({
        userId: user.$id,
        bankId: itemId,
        accountId: accountData.account_id,
        accessToken,
        fundingSourceUrl,
        sharableId: encryptId(accountData.account_id),
      });
  
      revalidatePath("/");
  
      return parseStringify({
        publicTokenExchange: "complete",
      });
    } catch (error) {
      console.error("Error creating exchangePublic:", error);
      throw new Error("Failed to exchange public token");
    }
  };
  export const getBanks = async ({ userId }: getBanksProps) => {
    try {
      const { database } = await createAdminClient();
  
      const banks = await database.listDocuments(
        DATABASE_ID!,
        BANK_COLLECTION_ID!,
        [Query.equal("userId", [userId])]
      );
  
      return parseStringify(banks.documents);
    } catch (error) {
      console.error("Error", error);
      return null;
    }
  };
  
  // get specific bank from bank collection by document id
  export const getBank = async ({ documentId }: getBankProps) => {
    try {
      const { database } = await createAdminClient();
  
      const bank = await database.listDocuments(
        DATABASE_ID!,
        BANK_COLLECTION_ID!,
        [Query.equal("$id", [documentId])]
      );
  
      if (bank.total !== 1) return null;
  
      return parseStringify(bank.documents[0]);
    } catch (error) {
      console.error("Error", error);
      return null;
    }
  };
  
  export const getBankByAccountId = async ({ accountId }: getBankByAccountIdProps) => {
    try {
      const { database } = await createAdminClient();
  
      const bank = await database.listDocuments(
        DATABASE_ID!,
        BANK_COLLECTION_ID!,
        [Query.equal('accountId', [accountId])]
      )
  
      if(bank.total !== 1) return null;
  
      return parseStringify(bank.documents[0]);
    } catch (error) {
      console.log(error)
    }
  }