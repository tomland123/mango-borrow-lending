A set of primitives to use Mango easily

Create a mango Object like this: 
```    
import { MangoBorrowLending } from "mango-borrow-lending";

const mango = await MangoBorrowLending.create({
      wallet,
    });

```

Easily deposit, refetch, borrow, or withdraw money from Mango 


```   
await mango.withdraw({
      token: new PublicKey("mango supported currency"),
      quantity: withdrawValue,
    });
```

```   
await mango.deposit({
      tokenDetail: mangoToken,
      quantity: withdrawValue,
    });
```

```
  await mango.borrow({
      token: new PublicKey("mango supported currency"),
      withdrawQuantity: withdrawValue,
    });
```

Refetch data 
```
 await mango.getBalances();
```
