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
      quantity: quantity,
    });
```

```   
await mango.deposit({
      tokenDetail: mangoToken,
      quantity: quantity,
    });
```

```
  await mango.borrow({
      token: new PublicKey("mango supported currency"),
      withdrawQuantity: withdrawQuantity,
    });
```

Refetch data 
```
 await mango.getBalances();
```
